// lib/parsers/index.js — GBK HTML 数据解析器出口
module.exports = {
  ...require('./sectors'),
  ...require('./rank'),
  ...require('./lhb'),
  ...require('./fundamental'),
};
