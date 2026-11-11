/* 验证「跨串文各段的图片合并 + 最多 4 张 + +N」
 *
 * 测的是真实代码，不是复制品：
 *   · TS.collectThreadMedia 直接从 src/extract.js 加载
 *   · 网格决策从 src/render.js 的真实 layout 拿（用桩 post 跑一遍）
 *
 * 用法：node tests/verify-thread-media.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ── 加载真实的 extract.js ──
// 它依赖 document/location，但 collectThreadMedia 是纯函数，
// 用一个最小桩让文件能求值即可。
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

const extractSrc = fs.readFileSync(path.join(ROOT, 'src', 'extract.js'), 'utf8');
new Function('globalThis', 'document', 'location', 'navigator', 'Node', 'window', 'setTimeout', 'clearTimeout', extractSrc)(
  g, g.document, g.location, g.navigator, g.Node, g.window, setTimeout, clearTimeout
);
const TS = g.TS;

if (!TS.collectThreadMedia) {
  console.error('✗ extract.js 未导出 collectThreadMedia');
  process.exit(1);
}

console.log('=== 串文媒体合并（真实代码） ===\n');

const mk = (n, prefix) =>
  Array.from({ length: n }, (_, i) => ({ src: `https://cdn.example/${prefix}-${i}.jpg?oe=abc`, w: 100, h: 100 }));

const cases = [
  { name: '主帖 2 张 + 续帖 0 张', thread: [{ media: mk(2, 'a') }, { media: [] }], expect: 2 },
  { name: '主帖 2 张 + 续帖 2 张', thread: [{ media: mk(2, 'a') }, { media: mk(2, 'b') }], expect: 4 },
  { name: '主帖 3 张 + 续帖 3 张（共 6）', thread: [{ media: mk(3, 'a') }, { media: mk(3, 'b') }], expect: 6 },
  { name: '主帖 8 张 + 续帖 0 张', thread: [{ media: mk(8, 'a') }, { media: [] }], expect: 8 },
  {
    name: '重复图片按路径去重',
    thread: [
      { media: [{ src: 'https://cdn.example/x.jpg?oe=1' }] },
      { media: [{ src: 'https://cdn.example/x.jpg?oe=2' }] },
    ],
    expect: 1,
  },
  { name: '空串文', thread: [], expect: 0 },
  { name: 'null 安全', thread: null, expect: 0 },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = TS.collectThreadMedia(c.thread);
  const ok = got.length === c.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}  →  ${got.length} 张（期望 ${c.expect}）`);
}

// ── 网格决策：直接问真实 render.js ──
// 用 node-canvas 不可行（无依赖），但 layout 只依赖 measureText。
// 提供最小 canvas 桩，让 render.js 能算 planMedia。
console.log('\n=== 网格与 +N 角标（真实 planMedia） ===\n');

function makeCanvasStub() {
  const ctx = {
    font: '',
    measureText: (s) => ({ width: s.length * 10 }),
    fillText: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    rect: () => {},
    arc: () => {},
    clip: () => {},
    fill: () => {},
    clearRect: () => {},
    setTransform: () => {},
    translate: () => {},
    scale: () => {},
    drawImage: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    getImageData: () => ({ data: [] }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
  };
  return { width: 300, height: 150, getContext: () => ctx, toDataURL: () => '' };
}

const renderG = { ...g, TS: {} };
renderG.globalThis = renderG;
renderG.document = {
  createElement: () => makeCanvasStub(),
};
renderG.TS.SERIF = 'serif';
renderG.TS.SANS = 'sans-serif';
renderG.TS.wrapText = (measure, text, maxW) => [text];
renderG.TS.squirclePath = () => {};
renderG.TS.formatCount = (n) => String(n);

const renderSrc = fs.readFileSync(path.join(ROOT, 'src', 'render.js'), 'utf8');
new Function('globalThis', 'document', renderSrc)(renderG, renderG.document);
const R = renderG.TS.Renderer;

if (!R || !R.layout) {
  console.error('✗ render.js 未导出 Renderer.layout');
  process.exit(1);
}

function makePost(nMedia) {
  return {
    author: { handle: 'u', displayName: 'u', avatarSrc: '', avatarEl: null },
    text: 'hello',
    media: Array.from({ length: nMedia }, (_, i) => ({
      src: `https://cdn.example/m-${i}.jpg`,
      w: 100,
      h: 100,
    })),
    time: { iso: '2026-11-11T00:00:00.000Z', human: '' },
    dateText: '2026年11月11日',
    counts: { like: 1, reply: 1, repost: 1, share: 1 },
    permalink: 'https://www.threads.com/@u/post/x',
  };
}

const gridCases = [
  // 圆点只在「有图没显示出来」时有意义：1 张不需要，4 张已全显示（画点是噪音），
  // 超过 4 张由末格 +N 表达剩余。所以只有 2、3 张时才有圆点。
  { n: 1, cells: 1, badge: null, dots: 0 },
  { n: 2, cells: 2, badge: null, dots: 2 },
  { n: 3, cells: 3, badge: null, dots: 3 },
  { n: 4, cells: 4, badge: null, dots: 0 },
  { n: 5, cells: 4, badge: '+1', dots: 0 },
  { n: 6, cells: 4, badge: '+2', dots: 0 },
  { n: 8, cells: 4, badge: '+4', dots: 0 },
  { n: 10, cells: 4, badge: '+6', dots: 0 },
];

for (const c of gridCases) {
  const plan = R.layout(makePost(c.n), null, { avatar: null, media: [] });
  const imageOps = plan.ops.filter((o) => o.kind === 'image');
  const badgeOps = plan.ops.filter((o) => o.kind === 'badge');
  const dotOps = plan.ops.filter((o) => o.kind === 'dot');
  const badgeText = badgeOps.length ? badgeOps[0].text : null;
  const ok = imageOps.length === c.cells && badgeText === c.badge && dotOps.length === c.dots;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.n} 张  →  画 ${imageOps.length} 格, 角标 ${badgeText || '(无)'}, 圆点 ${dotOps.length} 个` +
      (ok ? '' : `（期望 ${c.cells} 格 / ${c.badge || '无'} / ${c.dots} 点）`)
  );
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
