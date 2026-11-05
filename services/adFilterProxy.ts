/**
 * [adfilter] 本地 m3u8 广告过滤服务
 *
 * 思路：App 内起一个只处理 m3u8 的 TCP HTTP 服务（127.0.0.1:12347），
 * 播放器拿到的是 http://127.0.0.1:12347/f.m3u8?u=<编码后的上游地址>；
 * 服务端拉上游文本 -> 过滤广告块 -> 把分片/key 改写成上游绝对地址后返回。
 * 分片由 ExoPlayer 直连 CDN，不经过 JS，避免吞吐瓶颈。
 *
 * 过滤规则（照搬 temp_20261104_05/m3u8_ad_filter.py，基于 360zy 实测）：
 *   R1 出现 #EXT-X-KEY:METHOD=NONE 的段落 -> 广告块（正片为 AES-128）
 *   R2 分片路径不在本集资源目录 /YYYYMMDD/token/ 下 -> 广告（可关）
 *
 * 失败策略：宁可不去广告，也不能播不了。
 *   1) 上游抓取失败/非播放列表 -> 返回上一次成功过滤的列表（stale）
 *   2) 连 stale 都没有 -> 302 到原始上游地址（放行直连）
 *   3) 过滤后一个分片都不剩 -> 原样返回未过滤列表
 *
 * 日志：全部使用 console.info('[adfilter] ...')。
 * 注意：生产构建 babel 会移除 console（见 babel.config.js 注释），
 * 想在 release 包里用 adb logcat 观察，需要按文档改 babel 配置。
 */
import { Platform } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';

/** 过滤开关与参数：需要临时关掉过滤时，把 enabled 改成 false 重新打包即可 */
export const AD_FILTER_CONFIG = {
  enabled: true,
  port: 12347,
  /**
   * 只对这些源生效：命中 source(resource.key) 或 source_name 的子串。
   * 360zy 源在 MoonTV 里一般叫 "360资源"/"360zy"，用 "360" 即可。
   * 置为空数组表示"不按源名限制"，此时只按 hostPattern 判断。
   */
  sourceKeywords: ['360'],
  /** 兜底判断：播放地址的 host 命中这些域名时也启用（360zy CDN） */
  hostPattern: /(?:maowushi\.com|360zyx\.vip|360zy\.com)$/i,
  /** VOD 静态列表缓存（有 #EXT-X-ENDLIST 才缓存；直播列表不缓存） */
  cacheTtlMs: 90 * 1000,
  maxCacheEntries: 200,
  /** R2：分片路径不在本集目录前缀下则删除 */
  strictPathRule: true,
  upstreamTimeoutMs: 8 * 1000,
  /** 播放前预热超时：超时就先用原始地址播放，不阻塞用户 */
  prewarmTimeoutMs: 3 * 1000,
  upstreamReferer: 'https://360zy.com/',
  upstreamUserAgent:
    'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const log = (message: string, ...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.info(`[adfilter] ${message}`, ...args);
};

/** UTF-8 字节长度：部分 Hermes 版本没有 TextEncoder，这里做兜底，避免发送前就抛异常 */
const utf8ByteLength = (text: string): number => {
  const TextEncoderCtor = (globalThis as { TextEncoder?: new () => { encode(s: string): Uint8Array } })
    .TextEncoder;
  if (typeof TextEncoderCtor === 'function') return new TextEncoderCtor().encode(text).length;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
};

// ------------------------------------------------------------------ 类型

export interface FilterStats {
  /** 命中的广告块数量（METHOD=NONE 个数） */
  blocks: number;
  /** 被删掉的分片数（含 R2 路径规则） */
  removed: number;
  /** 其中因 R2 路径规则删掉的分片数 */
  pathRemoved: number;
  /** 保留的分片数 */
  kept: number;
  /** 上游原始分片数 */
  segmentsIn: number;
}

interface FilterResult {
  text: string;
  stats: FilterStats;
  isMaster: boolean;
  /** 过滤后没有可用分片，已回退为原始列表 */
  fellBackToRaw: boolean;
}

interface CacheEntry {
  at: number;
  text: string;
  stats: FilterStats;
}

type FetchOutcome =
  | { ok: true; finalUrl: string; text: string }
  | { ok: false; reason: string };

type PlaylistResult =
  | { kind: 'ok'; text: string; stats: FilterStats; cached: boolean }
  | { kind: 'redirect'; reason: string };

// ------------------------------------------------------------------ URL 工具

const URL_PARTS_RE = /^(https?):\/\/([^/?#]+)([^?#]*)(?:[?#].*)?$/i;

/** 取 URL 的 path 部分（不含 query/hash） */
export const urlPath = (url: string): string => {
  const m = URL_PARTS_RE.exec(url);
  return m ? m[3] || '/' : '';
};

export const hostOf = (url: string): string => {
  const m = URL_PARTS_RE.exec(url);
  return m ? m[2].toLowerCase() : '';
};

const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') {
      if (out.length > 1) out.pop();
    } else if (seg !== '.') {
      out.push(seg);
    }
  }
  const joined = out.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
};

/**
 * 极简 urljoin：把 ref 解析成绝对地址。
 * 不依赖 RN 的 URL 实现（RN 的 URL 不支持 base 参数）。
 */
export const resolveUrl = (base: string, ref: string): string => {
  const r = (ref || '').trim();
  if (!r) return base;
  if (/^https?:\/\//i.test(r)) return r;
  const bm = URL_PARTS_RE.exec(base);
  if (!bm) return r;
  const scheme = bm[1];
  const host = bm[2];
  if (r.startsWith('//')) return `${scheme}:${r}`;
  if (r.startsWith('?')) return `${scheme}://${host}${bm[3] || '/'}${r}`;
  const dir = r.startsWith('/') ? '/' : (bm[3] || '/').replace(/[^/]*$/, '');
  const path = r.startsWith('/') ? r : `${dir}${r}`;
  return `${scheme}://${host}${normalizePath(path)}`;
};

/** /20261031/Ju85F5mu/hls/index.m3u8 -> /20261031/Ju85F5mu/ */
export const episodePrefix = (url: string): string => {
  const parts = urlPath(url).split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return `/${parts[0]}/${parts[1]}/`;
};

const URI_ATTR_RE = /URI="([^"]+)"/gi;

/** 把 tag 里的 URI="..." 改成上游绝对地址（KEY/MAP/MEDIA/I-FRAME-STREAM-INF 等） */
export const absolutizeUriAttrs = (line: string, base: string): string =>
  line.replace(URI_ATTR_RE, (_all, uri: string) => `URI="${resolveUrl(base, uri)}"`);

export const isM3u8Url = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.m3u8$/i.test(urlPath(url));
};

// ------------------------------------------------------------------ 过滤逻辑

/**
 * 过滤一份播放列表。
 * @param text 上游原始文本
 * @param playlistUrl 上游最终 URL（跟随 302 后的地址），相对路径以此为基准
 */
export const filterPlaylist = (text: string, playlistUrl: string): FilterResult => {
  const raw = text.replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const stats: FilterStats = { blocks: 0, removed: 0, pathRemoved: 0, kept: 0, segmentsIn: 0 };
  const isMaster = lines.some((l) => l.trim().startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    // master 列表：子列表也交给本服务，这一层不删分片
    const out: string[] = [];
    for (const rawLine of lines) {
      const s = rawLine.trim();
      if (!s) continue;
      if (s.startsWith('#')) out.push(absolutizeUriAttrs(s, playlistUrl));
      else out.push(playUrl(resolveUrl(playlistUrl, s)));
    }
    return { text: `${out.join('\n')}\n`, stats, isMaster, fellBackToRaw: false };
  }

  const pfx = episodePrefix(playlistUrl);
  const out: string[] = [];
  let pendingDiscontinuity = false;
  let inAd = false;

  /** 删除最后一个分片的 EXTINF/DISCONTINUITY 头部（含 BYTERANGE） */
  const dropLastSegmentHeaders = () => {
    while (out.length > 0) {
      const last = out[out.length - 1];
      if (last.startsWith('#EXT-X-BYTERANGE')) {
        out.pop();
      } else if (last.startsWith('#EXTINF')) {
        out.pop();
        break;
      } else if (last.startsWith('#EXT-X-DISCONTINUITY')) {
        out.pop();
        break;
      } else {
        break;
      }
    }
  };

  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (!s) continue;

    if (s.startsWith('#EXT-X-ENDLIST')) {
      inAd = false;
      pendingDiscontinuity = false;
      out.push('#EXT-X-ENDLIST');
      continue;
    }

    if (s.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }

    if (s.startsWith('#EXT-X-KEY')) {
      if (/METHOD=NONE/i.test(s)) {
        // R1 命中：不加密 = 广告块
        inAd = true;
        pendingDiscontinuity = false;
        stats.blocks += 1;
        continue;
      }
      const keepDiscontinuity = pendingDiscontinuity && !inAd;
      inAd = false;
      if (keepDiscontinuity) out.push('#EXT-X-DISCONTINUITY');
      pendingDiscontinuity = false;
      out.push(absolutizeUriAttrs(s, playlistUrl));
      continue;
    }

    if (s.startsWith('#')) {
      if (inAd) continue;
      out.push(absolutizeUriAttrs(s, playlistUrl));
      continue;
    }

    // ---- 分片行 ----
    stats.segmentsIn += 1;

    if (inAd) {
      stats.removed += 1;
      continue;
    }

    const abs = resolveUrl(playlistUrl, s);
    if (AD_FILTER_CONFIG.strictPathRule && pfx && !urlPath(abs).startsWith(pfx)) {
      // R2：跨目录/跨域 = 广告分片
      dropLastSegmentHeaders();
      stats.removed += 1;
      stats.pathRemoved += 1;
      continue;
    }

    if (pendingDiscontinuity) {
      out.push('#EXT-X-DISCONTINUITY');
      pendingDiscontinuity = false;
    }
    // 关键：必须写成上游绝对地址，否则会被解析成 127.0.0.1 下的相对路径
    out.push(abs);
    stats.kept += 1;
  }

  if (stats.kept === 0 && stats.segmentsIn > 0) {
    // 过滤太狠（或规则命中异常），直接放行原始列表，保证可播
    return { text: raw, stats, isMaster, fellBackToRaw: true };
  }

  return { text: `${out.join('\n')}\n`, stats, isMaster, fellBackToRaw: false };
};

const playUrl = (upstream: string): string =>
  `http://127.0.0.1:${AD_FILTER_CONFIG.port}/f.m3u8?u=${encodeURIComponent(upstream)}`;

// ------------------------------------------------------------------ HTTP 服务

const getQueryParam = (query: string, name: string): string => {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) === name) {
      try {
        return decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, '%20'));
      } catch {
        return '';
      }
    }
  }
  return '';
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  302: 'Found',
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

class AdFilterProxyService {
  private server: TcpSocket.Server | null = null;
  private running = false;
  private starting: Promise<boolean> | null = null;
  private cache = new Map<string, CacheEntry>();
  private stale = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<FetchOutcome>>();

  get baseUrl(): string {
    return `http://127.0.0.1:${AD_FILTER_CONFIG.port}`;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 该 URL 是否需要走过滤（m3u8 + 命中源/域名） */
  public shouldFilter(url: string, source?: string, sourceName?: string): boolean {
    if (!isM3u8Url(url)) return false;
    if (AD_FILTER_CONFIG.hostPattern.test(hostOf(url))) return true;
    if (AD_FILTER_CONFIG.sourceKeywords.length > 0) {
      const keys = `${source || ''}|${sourceName || ''}`.toLowerCase();
      return AD_FILTER_CONFIG.sourceKeywords.some((k) => keys.includes(k.toLowerCase()));
    }
    return false;
  }

  /**
   * 播放地址改写入口：只在 m3u8 + 命中源时改写，其余（mp4/直链/服务未就绪）原样返回。
   */
  public rewritePlaybackUrl(url: string, source?: string, sourceName?: string): string {
    try {
      if (!AD_FILTER_CONFIG.enabled || !this.running) return url;
      if (!url || url.startsWith(this.baseUrl)) return url;
      if (!this.shouldFilter(url, source, sourceName)) return url;
      return `${this.baseUrl}/f.m3u8?u=${encodeURIComponent(url)}`;
    } catch {
      return url;
    }
  }

  public async start(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      log('skip: only android (expo-av/ExoPlayer) is supported');
      return false;
    }
    if (!AD_FILTER_CONFIG.enabled) {
      log('disabled by AD_FILTER_CONFIG.enabled');
      return false;
    }
    if (this.running) return true;
    if (this.starting) return this.starting;

    this.starting = new Promise<boolean>((resolve) => {
      try {
        this.server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          this.handleConnection(socket);
        });

        this.server.listen({ port: AD_FILTER_CONFIG.port, host: '127.0.0.1' }, () => {
          this.running = true;
          log(`listening on ${this.baseUrl}`);
          resolve(true);
        });

        this.server.on('error', (error: Error) => {
          this.running = false;
          this.server = null;
          log('server error (filter disabled, playback falls back to direct):', error.message);
          resolve(false);
        });
      } catch (error) {
        this.running = false;
        this.server = null;
        log('start failed:', (error as Error).message);
        resolve(false);
      }
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  public stop(): void {
    if (this.server && this.running) {
      this.server.close();
      log('stopped');
    }
    this.server = null;
    this.running = false;
  }

  // -- 连接处理 --

  private handleConnection(socket: TcpSocket.Socket): void {
    let buffer = '';
    let handled = false;

    socket.on('data', (data: string | Buffer) => {
      if (handled) return;
      buffer += data.toString();
      if (!buffer.includes('\r\n\r\n')) return;
      handled = true;

      const head = buffer.split('\r\n\r\n')[0];
      const requestLine = head.split('\r\n')[0] || '';
      const parts = requestLine.split(' ');
      const method = (parts[0] || 'GET').toUpperCase();
      const target = parts[1] || '/';

      this.route(socket, method, target).catch((error) => {
        log('route error:', error);
        this.send(socket, 500, 'text/plain', 'internal error');
      });
    });

    socket.on('error', (error: Error) => {
      log('socket error:', error.message);
    });
  }

  private async route(socket: TcpSocket.Socket, method: string, target: string): Promise<void> {
    const qi = target.indexOf('?');
    const path = qi >= 0 ? target.slice(0, qi) : target;
    const query = qi >= 0 ? target.slice(qi + 1) : '';

    if (path === '/healthz') {
      this.send(socket, 200, 'text/plain; charset=utf-8', 'adfilter ok');
      return;
    }

    if (path === '/f.m3u8') {
      await this.handlePlaylist(socket, getQueryParam(query, 'u'), method === 'HEAD');
      return;
    }

    this.send(socket, 404, 'text/plain; charset=utf-8', 'not found');
  }

  // -- 播放列表 --

  private async handlePlaylist(socket: TcpSocket.Socket, upstream: string, headOnly: boolean): Promise<void> {
    const url = (upstream || '').trim();

    if (!url || !/^https?:\/\//i.test(url) || hostOf(url).startsWith('127.0.0.1')) {
      this.send(socket, 400, 'text/plain; charset=utf-8', 'missing or invalid u');
      return;
    }

    let result: PlaylistResult;
    try {
      result = await this.getFiltered(url);
    } catch (error) {
      log('filter failed, redirect to raw:', (error as Error).message);
      result = { kind: 'redirect', reason: 'exception' };
    }

    if (result.kind === 'redirect') {
      // 放行原始地址：ExoPlayer 跟随 302 直连上游
      this.sendRedirect(socket, url, result.reason);
      return;
    }

    this.send(socket, 200, 'application/vnd.apple.mpegurl', result.text, {
      'X-ADFilter-Blocks': String(result.stats.blocks),
      'X-ADFilter-Removed': String(result.stats.removed),
      'X-ADFilter-Kept': String(result.stats.kept),
      'X-ADFilter-Cache': result.cached ? 'hit' : 'miss',
    }, headOnly);
  }

  /**
   * 播放前预热：确认代理链路真的能拿到播放列表。
   * 返回 false 表示"这条集数不要走代理"（直接播原始地址），从根上避免代理把播放卡死。
   * 成功时顺带把结果写入缓存，播放器随后请求几乎是瞬时的。
   */
  public async prewarm(url: string, source?: string, sourceName?: string): Promise<boolean> {
    try {
      if (!AD_FILTER_CONFIG.enabled || !this.running) return false;
      if (!url || !this.shouldFilter(url, source, sourceName)) return true;
      const result = await this.getFiltered(url, AD_FILTER_CONFIG.prewarmTimeoutMs);
      if (result.kind !== 'ok') log(`prewarm miss, play raw ${hostOf(url)}`);
      return result.kind === 'ok';
    } catch (error) {
      log('prewarm failed:', (error as Error).message);
      return false;
    }
  }

  private async getFiltered(
    url: string,
    timeoutMs = AD_FILTER_CONFIG.upstreamTimeoutMs,
  ): Promise<PlaylistResult> {
    const now = Date.now();
    const hit = this.cache.get(url);
    if (hit && now - hit.at < AD_FILTER_CONFIG.cacheTtlMs) {
      return { kind: 'ok', text: hit.text, stats: hit.stats, cached: true };
    }

    const outcome = await this.fetchPlaylist(url, timeoutMs);
    if (!outcome.ok) {
      const previous = this.stale.get(url);
      if (previous) {
        log(`upstream failed (${outcome.reason}), reuse stale ${hostOf(url)}`);
        return { kind: 'ok', text: previous.text, stats: previous.stats, cached: true };
      }
      // 打完整地址，方便用 adb logcat 抓出来在浏览器里直接对照上游是否可用
      log(`upstream failed (${outcome.reason}), passthrough ${hostOf(url)} url=${url}`);
      return { kind: 'redirect', reason: outcome.reason };
    }

    const filtered = filterPlaylist(outcome.text, outcome.finalUrl);
    const isLive = !outcome.text.includes('#EXT-X-ENDLIST');
    const entry: CacheEntry = { at: now, text: filtered.text, stats: filtered.stats };

    if (filtered.fellBackToRaw) {
      log(`filter would remove all segments, passthrough raw ${hostOf(url)}`);
    }

    const trim = (map: Map<string, CacheEntry>) => {
      while (map.size >= AD_FILTER_CONFIG.maxCacheEntries) {
        const firstKey = map.keys().next().value;
        if (firstKey === undefined) break;
        map.delete(firstKey);
      }
    };

    // 直播列表不进短缓存（每次刷新都要拿最新分片），只留作失败兜底
    if (!isLive) {
      trim(this.cache);
      this.cache.set(url, entry);
    }
    trim(this.stale);
    this.stale.set(url, entry);

    log(
      `m3u8 ${hostOf(url)} blocks=${filtered.stats.blocks} removed=${filtered.stats.removed}` +
        ` kept=${filtered.stats.kept} master=${filtered.isMaster ? 1 : 0} live=${isLive ? 1 : 0}`,
    );

    return { kind: 'ok', text: filtered.text, stats: filtered.stats, cached: false };
  }

  /** 同一 URL 的并发请求共享一次上游抓取 */
  private fetchPlaylist(url: string, timeoutMs: number): Promise<FetchOutcome> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const task = this.doFetch(url, timeoutMs).finally(() => {
      this.inflight.delete(url);
    });
    this.inflight.set(url, task);
    return task;
  }

  private async doFetch(url: string, timeoutMs: number): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 有些 CDN 对陌生 Referer 直接 403，带 Referer 失败时再裸请求一次
      const attempts: Record<string, string>[] = [
        {
          'User-Agent': AD_FILTER_CONFIG.upstreamUserAgent,
          Referer: AD_FILTER_CONFIG.upstreamReferer,
          Accept: '*/*',
        },
        { 'User-Agent': AD_FILTER_CONFIG.upstreamUserAgent, Accept: '*/*' },
      ];
      let lastReason = 'unknown';
      for (const headers of attempts) {
        try {
          const response = await fetch(url, { signal: controller.signal, headers });
          if (!response.ok) {
            lastReason = `http ${response.status}`;
            continue;
          }
          const text = await response.text();
          if (!text.trim().startsWith('#EXTM3U')) {
            lastReason = 'not a playlist';
            continue;
          }
          // RN 的 fetch 通常能给出跟随重定向后的地址；拿不到时退回原始地址
          const finalUrl = ((response as unknown as { url?: string }).url || url).trim() || url;
          return { ok: true, finalUrl, text };
        } catch (error) {
          lastReason =
            (error as Error).name === 'AbortError' || controller.signal.aborted
              ? 'timeout'
              : (error as Error).message;
        }
      }
      return { ok: false, reason: lastReason };
    } finally {
      clearTimeout(timer);
    }
  }

  // -- 响应 --

  /**
   * 关键修复：react-native-tcp-socket 的 end() 是在另一个执行器上直接 close socket 的，
   * 而 write() 是排队到 per-socket 写线程里异步执行的。write 之后立刻 end 存在竞态，
   * socket 可能先被 close，导致 ExoPlayer 收到空响应/半截响应 -> 整源播放失败。
   * 必须等 write 回调（native 写完）之后再 end。
   */
  private writeThenEnd(socket: TcpSocket.Socket, payload: string): void {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.end();
      } catch (error) {
        log('end failed:', (error as Error).message);
      }
    };
    try {
      socket.write(payload, 'utf8', finish);
    } catch (error) {
      log('write failed:', (error as Error).message);
      finish();
      return;
    }
    // 某些实现可能不回调：1s 后强制关闭，避免播放器请求悬挂
    setTimeout(finish, 1000);
  }

  private send(
    socket: TcpSocket.Socket,
    status: number,
    contentType: string,
    body: string,
    extra: Record<string, string> = {},
    headOnly = false,
  ): void {
    const bytes = utf8ByteLength(body);
    let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'OK'}\r\n`;
    head += `Content-Type: ${contentType}\r\n`;
    head += `Content-Length: ${bytes}\r\n`;
    head += 'Cache-Control: no-store\r\n';
    head += 'Connection: close\r\n';
    head += 'Access-Control-Allow-Origin: *\r\n';
    for (const [key, value] of Object.entries(extra)) head += `${key}: ${value}\r\n`;
    head += '\r\n';

    this.writeThenEnd(socket, headOnly ? head : head + body);
  }

  private sendRedirect(socket: TcpSocket.Socket, location: string, reason: string): void {
    let head = `HTTP/1.1 302 ${STATUS_TEXT[302]}\r\n`;
    head += `Location: ${location}\r\n`;
    head += 'Content-Length: 0\r\n';
    head += 'Connection: close\r\n';
    head += `X-ADFilter-Fallback: ${reason.replace(/[\r\n]/g, ' ')}\r\n`;
    head += '\r\n';

    this.writeThenEnd(socket, head);
  }
}

export const adFilterProxy = new AdFilterProxyService();
export default adFilterProxy;
