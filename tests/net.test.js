// tests/net.test.js — lib/net 解码与重定向跟随
import { describe, it, expect } from 'vitest';
import { decodeText } from '../lib/net';

describe('decodeText charset 嗅探', () => {
  it('GBK 页面解码', () => {
    // '龙虎榜' 的 GBK 字节：龙=C1FA 虎=BBA2 榜=B0F1
    const gbk = Buffer.from([0xc1, 0xfa, 0xbb, 0xa2, 0xb0, 0xf1]);
    const buf = Buffer.concat([
      Buffer.from('<!DOCTYPE html><meta charset="gbk"><title>', 'utf8'),
      gbk,
      Buffer.from('</title></html>', 'utf8'),
    ]);
    const out = decodeText(buf);
    expect(out).toContain('龙虎榜');
  });
  it('UTF-8 页面解码', () => {
    const buf = Buffer.from('<html><meta charset="utf-8"><title>测试</title></html>', 'utf8');
    expect(decodeText(buf)).toContain('测试');
  });
  it('UTF-8 BOM 识别', () => {
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('<html>你好</html>', 'utf8')]);
    expect(decodeText(buf)).toContain('你好');
  });
});
