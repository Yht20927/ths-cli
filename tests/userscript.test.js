// tests/userscript.test.js — 油猴脚本静态回归检查
// 防住几类曾导致线上故障的注入/轮询 bug。

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'tonghuashun.user.js'), 'utf8');

describe('油猴脚本静态检查', () => {
  it('无 const 变量被 += 再赋值（会秒败 poll 导致重连循环）', () => {
    // 只检查外层真实作用域（BRIDGE_CODE 注释块内是注入字符串，非真实作用域）
    const outer = SRC.split('(function () {/*')[0];
    const constDecls = [...outer.matchAll(/\bconst\s+(\w+)/g)].map(m => m[1]);
    const bad = constDecls.filter(name => new RegExp(`\\b${name}\\s*\\+=`).test(outer));
    expect(bad).toEqual([]);
  });

  it('pollUrl 用 let 声明（const 再赋值会秒败）', () => {
    expect(SRC).toMatch(/let pollUrl/);
    expect(SRC).not.toMatch(/const pollUrl/);
  });

  it('iframe 守卫存在（防止 iframe 实例抢注连接）', () => {
    expect(SRC).toContain('window.top !== window.self');
  });

  it('BRIDGE_CODE 注释块内无内部 */（会提前闭合注释破坏注入）', () => {
    const bridge = SRC.match(/\(function \(\) \{\/\*([\s\S]*?)\*\/\}\)\.toString/);
    expect(bridge).toBeTruthy();
    expect(bridge[1]).not.toMatch(/\*\//);
  });

  it('注入代码可独立解析（无顶层 async function 声明）', () => {
    const bridge = SRC.match(/\(function \(\) \{\/\*([\s\S]*?)\*\/\}\)\.toString/)[1];
    const asyncTopLevel = bridge.match(/^async function\s+\w+/m);
    expect(asyncTopLevel).toBeNull();
  });
});
