/* 生成 README 用的脱敏截图（精确版）
 *
 * 上一版失败原因：凭感觉用相对比例猜马赛克位置，
 * 结果打在卡片左上角的空白区，头像和账号名完全没遮住。
 *
 * 正确做法：按渲染参数算真实坐标。
 * 卡片布局是已知的（src/render.js 的 BASE_THEME）：
 *   frame.padding = 34, padding = 32, avatar = 56, 头像在 (P, P)
 *   姓名基线 = avatarY + 4 + name.size*0.8
 *   handle/时间行在其下方
 * 这些都是确定的数，直接算出马赛克矩形，不猜。
 *
 * 用法：node tools/make-readme-shots.js
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tests', 'renders');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// 与 src/render.js 的 BASE_THEME 保持一致
const T = {
  width: 640,
  padding: 32,
  framePadding: 34,
  avatar: 56,
  nameSize: 20,
  handleSize: 16,
};

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

/**
 * 卡片在画布上的几何（CSS 坐标）。
 * 画布 = 卡片 + frame padding，输出时乘了 scale(2)。
 */
/**
 * 卡片在画布上的几何（CSS 坐标）。
 * 画布 = 卡片 + frame padding，输出时乘了 scale(2)。
 *
 * 二维码位置依赖卡片总高度，而各截图高度不同，
 * 所以由调用方传入 canvasW/canvasH，从右下角反推 —— 不猜。
 */
function cardGeometry(scale, canvasW, canvasH) {
  const ox = T.framePadding; // 卡片左边距
  const oy = T.framePadding; // 卡片上边距
  const P = T.padding;

  // 卡片（CSS 尺寸）
  const cardW = canvasW / scale - T.framePadding * 2;
  const cardH = canvasH / scale - T.framePadding * 2;

  // 头像
  const avatar = {
    x: ox + P,
    y: oy + P,
    w: T.avatar,
    h: T.avatar,
  };

  // 姓名 + handle/时间 两行的横向范围：从头像右侧到卡片右边缘
  const textX = ox + P + T.avatar + 15;
  const textRight = ox + T.width - P;
  const nameTop = oy + P + 4;
  const nameBottom = nameTop + T.nameSize * 0.8 + T.handleSize + 10;

  const text = {
    x: textX,
    y: nameTop,
    w: textRight - textX,
    h: nameBottom - nameTop,
  };

  // 右上角品牌标记也要遮（它是 logo，不算隐私，但保持一致性可留）
  // 二维码里编码的是「真实原帖 URL」。
  // README 是公开页面，不能让人扫一下就跳到别人的帖子 —— 必须一起遮掉。
  // 它固定在卡片底部右侧（距卡片下沿 P，块高 = 二维码 + 说明文字）。
  const qrSize = 108;
  const blockH = qrSize + 14 + 16;
  const qr = {
    x: ox + cardW - P - qrSize,
    y: oy + cardH - P - blockH,
    w: qrSize,
    h: blockH,
  };

  const toPx = (r) => [r.x * scale, r.y * scale, r.w * scale, r.h * scale];
  return {
    avatar: toPx(avatar),
    text: toPx(text),
    qr: toPx(qr),
  };
}

/** 在浏览器里打马赛克：给定像素矩形 */
async function mosaicPx(page, pngBuf, rects) {
  const b64 = pngBuf.toString('base64');
  return page.evaluate(
    async ({ b64, rects }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = 'data:image/png;base64,' + b64;
      });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);

      for (const [x, y, w, h] of rects) {
        const rx = Math.max(0, Math.round(x));
        const ry = Math.max(0, Math.round(y));
        const rw = Math.min(cv.width - rx, Math.round(w));
        const rh = Math.min(cv.height - ry, Math.round(h));
        if (rw < 2 || rh < 2) continue;

        // 像素化：缩到很小再放大（最近邻），信息彻底丢失
        const block = Math.max(10, Math.round(Math.min(rw, rh) / 8));
        const tw = Math.max(1, Math.round(rw / block));
        const th = Math.max(1, Math.round(rh / block));

        const tmp = document.createElement('canvas');
        tmp.width = tw;
        tmp.height = th;
        tmp.getContext('2d').drawImage(cv, rx, ry, rw, rh, 0, 0, tw, th);

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tw, th, rx, ry, rw, rh);
        ctx.restore();
      }
      return cv.toDataURL('image/png').split('base64,')[1];
    },
    { b64, rects }
  );
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = pickChromium();
  const browser = await chromium.launch({ executablePath: exe || undefined, headless: true });
  const page = await browser.newPage();

  const geo = cardGeometry(2, 1416, 1086);
  const jobs = [
    { src: 'e2e-extension.png', out: 'card-basic.png' },
    { src: 'four-images.png', out: 'card-four-images.png' },
    { src: 'e2e-media.png', out: 'card-thread-media.png' },
    { src: 'detail-v2.png', out: 'card-detail.png' },
  ];

  for (const job of jobs) {
    const srcPath = path.join(SRC, job.src);
    if (!fs.existsSync(srcPath)) {
      console.log(`跳过（不存在）: ${job.src}`);
      continue;
    }
    const buf = fs.readFileSync(srcPath);

    // 每张图的画布尺寸不同，必须按各自的尺寸重新算几何
    const canvas = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = 'data:image/png;base64,' + b64;
      });
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, buf.toString('base64'));

    const g = cardGeometry(2, canvas.w, canvas.h);
    const outB64 = await mosaicPx(page, buf, [g.avatar, g.text, g.qr]);
    const outPath = path.join(OUT, job.out);
    fs.writeFileSync(outPath, Buffer.from(outB64, 'base64'));
    console.log(
      `✓ ${job.out}  ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB  ` +
        `画布 ${canvas.w}x${canvas.h}  遮罩 头像+账号+二维码`
    );
  }

  await browser.close();
  console.log('\n完成 → docs/screenshots/');
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
