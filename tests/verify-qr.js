/* QR 可扫性验证
 *
 * 只验矩阵结构「看起来对」是不够的 —— 必须真的解码出来。
 * 这里用 jsqr（独立实现）解码我们自己生成的图，
 * 只有解出与原文一致的字符串，才能说明二维码能被手机扫开。
 *
 * 用法：node tests/verify-qr.js
 */
const path = require('path');
const fs = require('fs');
const jsQR = require('jsqr');

const ROOT = path.resolve(__dirname, '..');

// 在 Node 里跑浏览器端 qrcode.js：它只依赖 globalThis
const src = fs.readFileSync(path.join(ROOT, 'src', 'qrcode.js'), 'utf8');
const sandbox = { globalThis: {} };
new Function('globalThis', src)(sandbox.globalThis);
const TS = sandbox.globalThis.TS;

if (!TS || !TS.qrMatrix) {
  console.error('✗ qrcode.js 未导出 qrMatrix');
  process.exit(1);
}

/** 把矩阵渲染成 RGBA 像素（给 jsQR 用） */
function renderToRgba(qr, scale, quiet) {
  const n = qr.size + quiet * 2;
  const w = n * scale;
  const data = new Uint8ClampedArray(w * w * 4);
  // 全白
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
  }
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.matrix[r][c]) continue;
      const x0 = (c + quiet) * scale;
      const y0 = (r + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((y0 + dy) * w + (x0 + dx)) * 4;
          data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, w };
}

const cases = [
  'https://www.threads.com/@demo_user/post/DfkZ90EEmEX',
  'https://www.threads.com/@demo_alpha/post/Dfj4qy2lX7S',
  'https://www.threads.com/@demo_beta/post/DfkONtLE8zM',
  'https://www.threads.com/@a.b_c-d/post/Xyz123AbCdE',
  // 长一点的（带 query）
  'https://www.threads.com/@someone.ok/post/DfkONtLE8zM?hl=zh_CN&utm_source=copy',
];

let pass = 0;
let fail = 0;
console.log('=== QR 解码验证（jsQR 独立实现） ===\n');

for (const text of cases) {
  const qr = TS.qrMatrix(text);
  if (!qr) {
    console.log(`✗ 生成失败: ${text}`);
    fail++;
    continue;
  }
  const scale = 6;
  const quiet = 4;
  const { data, w } = renderToRgba(qr, scale, quiet);
  const decoded = jsQR(data, w, w);
  const got = decoded && decoded.data;
  const ok = got === text;
  if (ok) pass++; else fail++;
  console.log(
    `${ok ? '✓' : '✗'} v${(qr.size - 17) / 4} ${qr.size}x${qr.size}  ` +
    `len=${text.length}  ${ok ? '解码一致' : '解码不符: ' + JSON.stringify(got)}`
  );
  if (!ok) console.log(`   期望: ${text}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
