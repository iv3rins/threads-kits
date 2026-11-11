/* 微信式二维码：中间留空（可放任意图），且必须仍能扫出
 *
 * 微信/支付宝的做法是：把中间若干模块整体"挖空"成纯白，
 * 靠纠错码补回损失的区域。能不能扫取决于两点：
 *   1) 挖空面积 ≤ 纠错能力（等级 M 约 15%，H 约 30%）
 *   2) 挖空区域不能压到定位/校正图案
 *
 * 这个脚本穷举「中心留空边长占比」，用 jsQR 独立解码找出真实上限，
 * 而不是照抄一个数字。
 *
 * 用法：node tests/verify-qr-hole.js
 */
const path = require('path');
const fs = require('fs');
const jsQR = require('jsqr');

const ROOT = path.resolve(__dirname, '..');
const g = {};
new Function('globalThis', fs.readFileSync(path.join(ROOT, 'src/qrcode.js'), 'utf8'))(g);
const TS = g.TS;

/** 渲染矩阵为 RGBA，可选挖空中心方形 */
function render(qr, scale, quiet, holeRatio) {
  const n = qr.size + quiet * 2;
  const w = n * scale;
  const data = new Uint8ClampedArray(w * w * 4);
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
  if (holeRatio > 0) {
    const cx = w / 2;
    const cy = w / 2;
    const half = (w * holeRatio) / 2;
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) {
          const idx = (y * w + x) * 4;
          data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, w };
}

const urls = [
  'https://www.threads.com/@demo_user/post/DfkZ90EEmEX',
  'https://www.threads.com/@demo_alpha/post/Dfj4qy2lX7S',
  'https://www.threads.com/@demo_beta/post/DfkONtLE8zM',
  'https://www.threads.com/@someone.ok/post/DfkONtLE8zM?hl=zh_CN',
];

console.log('=== 中心留空（微信式）可扫性穷举 ===\n');

const ratios = [0, 0.16, 0.20, 0.24, 0.28, 0.30, 0.32, 0.34, 0.36, 0.40];
let safeMax = 0;

for (const ratio of ratios) {
  let pass = 0;
  for (const url of urls) {
    const qr = TS.qrMatrix(url);
    if (!qr) continue;
    const { data, w } = render(qr, 6, 1, ratio);
    const dec = jsQR(data, w, w);
    if (dec && dec.data === url) pass++;
  }
  const ok = pass === urls.length;
  if (ok) safeMax = ratio;
  console.log(
    `留空占宽 ${(ratio * 100).toFixed(0).padStart(2)}%  →  ${pass}/${urls.length} 可解码  ${ok ? '✓' : '✗'}`
  );
}

console.log(`\n安全上限（全部解码通过的最大值）: ${(safeMax * 100).toFixed(0)}%`);

// 二维码版本分布
console.log('\n各链接的版本（H 级纠错）：');
for (const url of urls) {
  const qr = TS.qrMatrix(url);
  console.log(`  v${(qr.size - 17) / 4}  ${qr.size}x${qr.size}  len=${url.length}`);
}
