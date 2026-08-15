// lib/commands/index.js — 命令注册表

module.exports = {
  search: require('./search'),
  quote: require('./quote'),
  quotes: require('./quotes'),
  kline: require('./kline'),
  trend: require('./trend'),
  turnover: require('./turnover'),
  analyze: require('./analyze'),
  compare: require('./compare'),
  scan: require('./scan'),
  watchlist: require('./watchlist'),
  backtest: require('./backtest'),
  position: require('./position'),
  market: require('./market'),
  fundflow: require('./fundflow'),
  sectors: require('./sectors'),
  rank: require('./rank'),
  lhb: require('./lhb'),
  fundamental: require('./fundamental'),
  portfolio: require('./portfolio'),
};
