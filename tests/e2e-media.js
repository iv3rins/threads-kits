/* 真实扩展验证（多图 + 串文）
 *
 * 与 e2e-extension.js 的区别：夹具换成带 8 张图的主帖 + 同作者续帖，
 * 验证多图网格、串文合并、+N 角标这几条新路径在真实扩展环境里成立。
 *
 * 用法：node tests/e2e-media.js
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW_CANDIDATES = [
  'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core',
];
const localPw = LOCAL_PW_CANDIDATES.find((p) => fs.existsSync(p));
const { chromium } = require(localPw || 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'renders');
const FIXTURE = path.join(ROOT, 'tests', 'dumps', 'post-images-thread.html');

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
  const report = [];
  const say = (s) => {
    console.log(s);
    report.push(s);
  };

  if (!fs.existsSync(FIXTURE)) throw new Error('缺少夹具：' + FIXTURE);
  fs.mkdirSync(OUT, { recursive: true });

  const userDataDir = path.join(ROOT, 'tests', '.chrome-profile-media');
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromiumPath = pickChromium();
  say(`[0] 浏览器: ${chromiumPath || '(默认)'}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    args: [
      '--headless=new',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') say('    [console.error] ' + m.text().slice(0, 200));
    });

    await page.route('https://www.threads.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>threads media fixture</title></head>
<body><div id="app">${fixtureHtml}</div></body></html>`,
      });
    });

    await page.goto('https://www.threads.com/@demo_beta/post/DfkONtLE8zM', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(2500);

    const mounted = await page.evaluate(() => ({
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
    }));
    say(`[1] 挂载: 容器=${mounted.containers} 按钮=${mounted.buttons} ` +
      (mounted.buttons === mounted.containers && mounted.containers > 0 ? 'OK' : 'FAIL'));
    if (mounted.buttons === 0) throw new Error('按钮未挂载');

    // 点主帖的按钮 → 应合并串文
    await page.click('.threshare-btn');
    await page.waitForTimeout(3000);

    const res = await page.evaluate(async () => {
      const host = document.getElementById('threshare-overlay-host');
      if (!host || !host.shadowRoot) return { error: 'no overlay' };
      const sr = host.shadowRoot;
      const canvas = sr.querySelector('canvas');
      if (!canvas) return { error: 'no canvas' };
      const hint = (sr.querySelector('.hint') || {}).textContent || '';
      let dataUrl = null;
      let err = null;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (e) {
        err = e.message;
      }
      return { w: canvas.width, h: canvas.height, hint, dataUrl, err };
    });

    if (res.error) throw new Error(res.error);
    say(`[2] 画布: ${res.w}x${res.h} ${res.w > 0 ? 'OK' : 'FAIL'}`);
    say(`[3] 底部提示: "${res.hint}"`);
    say(`[4] 串文已合并: ${/串文.*合并/.test(res.hint) ? 'OK' : 'FAIL'}`);
    say(`[5] 多图已识别: ${/张媒体/.test(res.hint) ? 'OK' : 'FAIL'}`);
    say(`[6] 导出可用: ${res.dataUrl && !res.err ? 'OK' : 'FAIL ' + (res.err || '')}`);

    // 校验画布上确实画了 4 格媒体（多图网格），而非只画 1 张
    const grid = await page.evaluate(() => {
      const sr = document.getElementById('threshare-overlay-host').shadowRoot;
      const canvas = sr.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const s = 2;
      // 扫描媒体区域（正文下方），统计"非背景色"的列分布，判断是否两列布局
      const cardX = 34, cardY = 34;
      const scanTop = Math.round((cardY + 200) * s);
      const scanBot = Math.round((cardY + 900) * s);
      const W = canvas.width;
      const colHits = new Array(40).fill(0);
      const data = ctx.getImageData(0, scanTop, W, Math.min(scanBot - scanTop, canvas.height - scanTop)).data;
      const rowW = W;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // 照片像素通常有明显色彩差异；纯白卡片不是
        if (Math.abs(r - g) + Math.abs(g - b) > 12 || (r < 235 && g < 235 && b < 235)) {
          const px = (i / 4) % rowW;
          const bucket = Math.floor((px / W) * 40);
          colHits[bucket]++;
        }
      }
      const occupied = colHits.map((v, i) => ({ i, v })).filter((x) => x.v > 200);
      return {
        occupiedBuckets: occupied.length,
        leftHalf: colHits.slice(0, 20).reduce((a, b) => a + b, 0),
        rightHalf: colHits.slice(20).reduce((a, b) => a + b, 0),
      };
    });
    const twoCols = grid.leftHalf > 1000 && grid.rightHalf > 1000;
    say(`[7] 媒体区域: 左半=${grid.leftHalf} 右半=${grid.rightHalf} 占用列=${grid.occupiedBuckets} ` +
      (twoCols ? 'OK(两列)' : 'FAIL(疑似单列)'));

    if (res.dataUrl) {
      const out = path.join(OUT, 'e2e-media.png');
      fs.writeFileSync(out, Buffer.from(res.dataUrl.split('base64,')[1], 'base64'));
      say(`[8] 已保存 ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
    }
    await page.screenshot({ path: path.join(OUT, 'e2e-media-overlay.png') });
    say('[9] 弹层截图已保存');

    const allOk = mounted.buttons === mounted.containers && res.w > 0 &&
      /串文.*合并/.test(res.hint) && /张媒体/.test(res.hint) && twoCols && !res.err;
    say('');
    say(allOk ? '=== 全部通过 ===' : '=== 存在失败项 ===');
    process.exitCode = allOk ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.writeFileSync(path.join(ROOT, 'tests', 'e2e-media-report.txt'), report.join('\n'), 'utf8');
  }
})();
