// lib/commands/index.js — 命令注册表

module.exports = {
  search: require('./search'),
  quote: require('./quote'),
  kline: require('./kline'),
  trend: require('./trend'),
  turnover: require('./turnover'),
  analyze: require('./analyze'),
  scan: require('./scan'),
  watchlist: require('./watchlist'),
  backtest: require('./backtest'),
};
