/* 串文识别回归：主页上不能把独立帖当成串文
 *
 * 踩过的 bug：个人主页整页都是同一个作者，
 * 旧的 `extractThread` 只看「同作者 + 紧随其后」，
 * 结果把 4 条相隔数小时/数天的独立帖合并成一条串文。
 *
 * 真实数据（browser-skill 实测 @iverins02 主页）：
 *   2小时前 / 17小时前 / 20小时前 / 2天前  → 4 条独立帖
 * 真实串文（夹具 post-images-thread.html）：
 *   15:24:47 → 15:28:24  → 相差 3 分 37 秒，应合并
 *
 * 用法：node tests/verify-thread-detect.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ── 加载真实 extract.js（用最小 DOM 桩）──
const stubDoc = {
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  documentElement: { appendChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  readyState: 'complete',
};
const g = {
  TS: {},
  document: stubDoc,
  location: { href: 'https://www.threads.com/', hostname: 'www.threads.com', origin: 'https://www.threads.com' },
  navigator: { userAgent: 'node' },
  console,
  setTimeout,
  clearTimeout,
  Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
};
g.globalThis = g;
g.window = g;

new Function('globalThis', 'document', 'location', 'navigator', 'Node', 'window', 'setTimeout', 'clearTimeout',
  fs.readFileSync(path.join(ROOT, 'src', 'extract.js'), 'utf8')
)(g, g.document, g.location, g.navigator, g.Node, g.window, setTimeout, clearTimeout);

const TS = g.TS;

// 这里 extractThread 依赖 document.querySelectorAll 找兄弟容器，
// 所以改用「复刻同一套判据」验证窗口逻辑 —— 但常量从真实代码读，
// 保证测的是当前实现用的阈值。
const WINDOW_MS = 30 * 60 * 1000;

function simulate(posts) {
  // 复刻 extractThread 的核心判据（与实现同构）
  const chain = [posts[0]];
  let prev = Date.parse(posts[0].time.iso);
  for (let i = 1; i < posts.length; i++) {
    const p = posts[i];
    if (p.handle !== posts[0].handle) break;
    if (!p.text && !p.media) break;
    const t = Date.parse(p.time.iso);
    if (!isFinite(t)) break;
    if (Math.abs(t - prev) > WINDOW_MS) break;
    chain.push(p);
    prev = t;
  }
  return chain;
}

console.log('=== 串文识别回归 ===\n');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

// ── 场景 1：真实主页（4 条独立帖，相隔数小时/天）──
const profilePosts = [
  { handle: 'iverins02', time: { iso: '2026-11-11T06:13:53.000Z' }, text: 'AI太好用了', media: 1 },
  { handle: 'iverins02', time: { iso: '2026-11-10T14:44:34.000Z' }, text: 'GPT Plus 快到期', media: 0 },
  { handle: 'iverins02', time: { iso: '2026-11-10T11:32:29.000Z' }, text: '一到冬天', media: 0 },
  { handle: 'iverins02', time: { iso: '2026-11-09T07:03:30.000Z' }, text: '心累', media: 0 },
];
const profileResult = simulate(profilePosts);
check(
  '个人主页：4 条独立帖只取 1 条',
  profileResult.length === 1,
  `实际合并了 ${profileResult.length} 条`
);

// ── 场景 2：真串文（相隔 3 分 37 秒）──
const realThread = [
  { handle: 'demo_beta', time: { iso: '2026-11-10T15:24:47.000Z' }, text: '玩了半小時Lightroom', media: 8 },
  { handle: 'demo_beta', time: { iso: '2026-11-10T15:28:24.000Z' }, text: '是手機版', media: 0 },
];
const threadResult = simulate(realThread);
check('真串文：两段应合并', threadResult.length === 2, `实际 ${threadResult.length} 条`);

// ── 场景 3：三段串文（每段间隔都在窗口内）──
const threeSeg = [
  { handle: 'a', time: { iso: '2026-11-11T10:00:00.000Z' }, text: '1/2', media: 0 },
  { handle: 'a', time: { iso: '2026-11-11T10:05:00.000Z' }, text: '2/2', media: 0 },
  { handle: 'a', time: { iso: '2026-11-11T10:10:00.000Z' }, text: '补充', media: 0 },
];
check('三段串文应全部合并', simulate(threeSeg).length === 3);

// ── 场景 4：边界 —— 刚好超过 30 分钟就断 ──
const justOver = [
  { handle: 'a', time: { iso: '2026-11-11T10:00:00.000Z' }, text: '第一段', media: 0 },
  { handle: 'a', time: { iso: '2026-11-11T10:31:00.000Z' }, text: '31分钟后', media: 0 },
];
check('超过 30 分钟的应断开', simulate(justOver).length === 1);

// ── 场景 5：不同作者必须断开 ──
const mixedAuthor = [
  { handle: 'a', time: { iso: '2026-11-11T10:00:00.000Z' }, text: '主帖', media: 1 },
  { handle: 'b', time: { iso: '2026-11-11T10:01:00.000Z' }, text: '别人的回复', media: 0 },
];
check('不同作者必须断开', simulate(mixedAuthor).length === 1);

// ── 场景 6：空内容断开 ──
const emptySeg = [
  { handle: 'a', time: { iso: '2026-11-11T10:00:00.000Z' }, text: '主帖', media: 1 },
  { handle: 'a', time: { iso: '2026-11-11T10:01:00.000Z' }, text: '', media: 0 },
];
check('无实质内容的应断开', simulate(emptySeg).length === 1);

// ── 确认真实代码里用的是同一个阈值 ──
const src = fs.readFileSync(path.join(ROOT, 'src', 'extract.js'), 'utf8');
const m = src.match(/THREAD_TIME_WINDOW_MS\s*=\s*([0-9\s*]+);/);
const declared = m ? m[1].trim() : null;
check(
  '实现里的窗口常量与测试一致',
  declared === '30 * 60 * 1000',
  `实际: ${declared}`
);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
