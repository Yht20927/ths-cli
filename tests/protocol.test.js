// tests/protocol.test.js — Bridge 协议校验

import { describe, it, expect } from 'vitest';
import { validateHello, validateResult, validateCallRequest } from '../lib/shared/protocol.js';

describe('validateHello', () => {
  it('合法 hello', () => {
    const r = validateHello({ type: 'hello', site: '10jqka.com.cn', url: 'https://stockpage.10jqka.com.cn/600519/', title: '贵州茅台' });
    expect(r.valid).toBe(true);
    expect(r.data.site).toBe('10jqka.com.cn');
    expect(r.data.url).toContain('600519');
  });
  it('缺 site', () => {
    expect(validateHello({ type: 'hello' }).valid).toBe(false);
  });
  it('type 不对', () => {
    expect(validateHello({ type: 'eval', site: 'x' }).valid).toBe(false);
  });
  it('非对象', () => {
    expect(validateHello(null).valid).toBe(false);
  });
});

describe('validateResult', () => {
  it('合法 result', () => {
    expect(validateResult({ type: 'result', id: 'abc', value: { close: 1206.91 } }).valid).toBe(true);
  });
  it('缺 id 或 value/error', () => {
    expect(validateResult({ type: 'result', value: 1 }).valid).toBe(false);
    expect(validateResult({ type: 'result', id: 'abc' }).valid).toBe(false);
  });
  it('error 形式', () => {
    expect(validateResult({ type: 'result', id: 'abc', error: 'boom' }).valid).toBe(true);
  });
});

describe('validateCallRequest', () => {
  it('合法 call', () => {
    const r = validateCallRequest({ site: '10jqka.com.cn', expression: 'window.__ths.kline(...)' });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(true);
    expect(r.data.connIndex).toBe(0);
    expect(r.data.timeout).toBeNull();
  });
  it('缺 expression', () => {
    expect(validateCallRequest({ site: 'x' }).valid).toBe(false);
  });
  it('缺 site', () => {
    expect(validateCallRequest({ expression: '1' }).valid).toBe(false);
  });
  it('非对象', () => {
    expect(validateCallRequest('x').valid).toBe(false);
  });
});
