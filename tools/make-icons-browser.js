/* 用浏览器渲染官方 SVG 路径，导出多尺寸 PNG 图标
 *
 * 为什么不自己写路径光栅化：Threads 的 logo 路径有相对 moveto（m）和
 * 多个子路径，手写的扫描线填充处理不好，画出来是扭曲的（试过，明显不对）。
 * 交给浏览器的 SVG 渲染器最可靠。
 *
 * 用法：node tools/make-icons-browser.js
 *   （需要 dev-server 在 8788 运行，脚本会在本地页面里渲染再读像素）
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW = 'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core';
const { chromium } = require(fs.existsSync(LOCAL_PW) ? LOCAL_PW : 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'icons');

const MARK_PATH =
  'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z';

function pickChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'chrome.exe' && p.includes('chromium-')) found.push(p);
    }
  };
  walk(base, 0);
  return found[0] || null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = pickChromium();
  const browser = await chromium.launch({ executablePath: exe || undefined, headless: true });
  const page = await browser.newPage();

  // 在空白页里用 SVG 渲染 logo，返回各尺寸 PNG 的 base64
  const results = await page.evaluate(async (markPath) => {
    const sizes = [16, 32, 48, 128];
    const out = {};

    async function renderAt(size, opts) {
      const { bg, fg, fillRatio, rounded } = opts;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const ctx = cv.getContext('2d');

      // 底色（可选，圆角）
      if (bg) {
        ctx.fillStyle = bg;
        if (rounded) {
          const r = size * 0.22;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(0, 0, size, size, r);
          else ctx.rect(0, 0, size, size);
          ctx.fill();
        } else {
          ctx.fillRect(0, 0, size, size);
        }
      }

      // 用 SVG 渲染标记，保证形状正确
      const target = size * fillRatio;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${target}" height="${target}">
        <path fill="${fg}" d="${markPath}"/></svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      ctx.drawImage(img, (size - target) / 2, (size - target) / 2, target, target);
      URL.revokeObjectURL(url);
      return cv.toDataURL('image/png');
    }

    for (const s of sizes) {
      // 工具栏图标：浅色底 + 深色标（与 Chrome 亮色主题协调）
      out[s] = await renderAt(s, { fg: '#0F1419', fillRatio: 0.68, bg: null });
    }
    return out;
  }, MARK_PATH);

  for (const [size, dataUrl] of Object.entries(results)) {
    const b64 = dataUrl.split('base64,')[1];
    const file = path.join(OUT, `icon-${size}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`✓ ${file} (${size}x${size}, ${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
  }

  await browser.close();
  console.log('\n完成');
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
