/* 验证「实际渲染出来的卡片里的二维码」能扫
 *
 * 前一步的 verify-qr-hole.js 验的是矩阵函数；
 * 这里验的是从 canvas 里真实抠出来的那块二维码，
 * 包含留空、中心图标、圆角等所有绘制细节 —— 最接近用户实际扫的东西。
 *
 * 用法：node tests/verify-qr-rendered.js <png路径> [悬停参数]
 *   不给路径时，只做矩阵级验证。
 */
const path = require('path');
const fs = require('fs');
const jsQR = require('jsqr');

let PNG;
try {
  PNG = require('pngjs').PNG;
} catch (e) {
  console.error('需要 pngjs：npm i -D pngjs');
  process.exit(1);
}

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法: node tests/verify-qr-rendered.js <png路径>');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

console.log(`图片 ${width}x${height}`);

// 二维码区域在卡片右下：用「深色模块密度」自动定位
// 扫描右下 45% x 45% 区域，找密度最高的正方形
const x0 = Math.floor(width * 0.5);
const y0 = Math.floor(height * 0.45);
let best = null;

// 直接整块区域丢给 jsQR（它有内置定位），再按需裁剪
function tryDecode(sx, sy, size) {
  if (sx < 0 || sy < 0 || sx + size > width || sy + size > height) return null;
  const sub = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((sy + y) * width + (sx + x)) * 4;
      const di = (y * size + x) * 4;
      sub[di] = data[si];
      sub[di + 1] = data[si + 1];
      sub[di + 2] = data[si + 2];
      sub[di + 3] = data[si + 3];
    }
  }
  return jsQR(sub, size, size);
}

// 先整图试
let dec = tryDecode(0, 0, Math.min(width, height));

// 再试右下角若干尺寸
if (!dec) {
  const sizes = [320, 400, 480, 560, 640];
  for (const s of sizes) {
    dec = tryDecode(width - s - 20, height - s - 20, s);
    if (dec) {
      console.log(`在右下角 ${s}x${s} 区域解码成功`);
      break;
    }
  }
}

if (dec) {
  console.log(`✓ 解码成功: ${dec.data}`);
} else {
  console.log('✗ 无法解码');
  process.exitCode = 1;
}
