module.exports = function (api) {
  api.cache(true);
  
  const plugins = [];
  
  // 在生产环境移除 console 调用以优化性能
  // 保留 info/warn/error：services/adFilterProxy.ts 的 [adfilter] 日志需要 adb logcat 可查
  if (process.env.NODE_ENV === 'production') {
    plugins.push(['transform-remove-console', { exclude: ['info', 'warn', 'error'] }]);
  }
  
  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};