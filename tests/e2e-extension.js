/* 真实扩展验证
 *
 * 与 harness 的区别：这里走 Chrome 真正的扩展加载路径 ——
 * MV3 manifest 解析、content_scripts 注入、扩展上下文隔离，全都真跑一遍。
 * harness 只能证明代码逻辑对，证明不了"装进浏览器还能用"。
 *
 * 用法：node tests/e2e-extension.js
 */
const path = require('path');
const fs = require('fs');

// 复用本机已有的 playwright-core（不额外下载浏览器）
const LOCAL_PW_CANDIDATES = [
  'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core',
];
const localPw = LOCAL_PW_CANDIDATES.find((p) => fs.existsSync(p));
const { chromium } = require(localPw || 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'renders');
const FIXTURE = path.join(ROOT, 'tests', 'dumps', 'post-page-1.html');

/** 优先用本机已装好的 Chromium（Playwright 自带的那份），
 *  它不受 Chrome 137+ 禁用 --load-extension 的影响 */
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
  if (found.length) return found[0];
  return null;
}

(async () => {
  const report = [];
  const say = (s) => {
    console.log(s);
    report.push(s);
  };

  if (!fs.existsSync(FIXTURE)) throw new Error('缺少夹具：' + FIXTURE);
  fs.mkdirSync(OUT, { recursive: true });

  const userDataDir = path.join(ROOT, 'tests', '.chrome-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromiumPath = pickChromium();
  say(`[0] 使用浏览器: ${chromiumPath || '(playwright 默认)'}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    // 旧 headless 模式不支持扩展；--headless=new 才与有头共享扩展加载路径
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
    // 扩展是否真的被加载（MV3 会注册 service worker；本插件无 SW，则看 background 页）
    const ids = [];
    // 有些 Chrome 版本不暴露 sw，改用 chrome://extensions 判定
    const probe = await ctx.newPage();
    await probe.goto('chrome://extensions/');
    const extCount = await probe.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return -1;
      const list = mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list || !list.shadowRoot) return -1;
      return list.shadowRoot.querySelectorAll('extensions-item').length;
    });
    say(`[1] 已加载扩展数量: ${extCount} ${extCount > 0 ? 'OK' : 'FAIL'}`);

    const extInfo = await probe.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr.shadowRoot.querySelector('extensions-item-list');
      return [...list.shadowRoot.querySelectorAll('extensions-item')].map((el) => ({
        id: el.getAttribute('id'),
        name: el.shadowRoot ? (el.shadowRoot.querySelector('#name') || {}).textContent : null,
        errors: el.shadowRoot && el.shadowRoot.querySelector('#errors-button') ? true : false,
      }));
    });
    say('[2] 扩展清单: ' + JSON.stringify(extInfo));
    const maniErrors = extCount > 0 && extInfo.every((e) => !e.errors);
    say(`[3] 无 manifest/加载错误: ${maniErrors ? 'OK' : 'FAIL'}`);
    await probe.close();

    // 在本地 http 上跑：把夹具做成一个页面，扩展的 match 是 threads.com，所以要拦截路由伪装
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') say('    [console.error] ' + m.text().slice(0, 200));
    });

    const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');
    // 用 route 把 threads.com 的请求换成本地夹具，从而命中 content_scripts.matches
    await page.route('https://www.threads.com/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('.js')) return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>threads fixture</title></head>
<body><div id="app">${fixtureHtml}</div></body></html>`,
      });
    });

    await page.goto('https://www.threads.com/@demo_alpha/post/Dfj4qy2lX7S', {
      waitUntil: 'domcontentloaded',
    });

    // content script 在 document_idle 注入，等它跑完
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => ({
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
      styleTag: !!document.getElementById('threshare-btn-style'),
    }));
    say(
      `[4] content script 注入: 容器=${state.containers} 按钮=${state.buttons} 样式=${state.styleTag} ` +
        (state.buttons > 0 && state.buttons === state.containers ? 'OK' : 'FAIL')
    );
    if (state.buttons === 0) throw new Error('content script 没有挂上按钮');

    // 点击 → 等弹层 → 取画布
    await page.click('.threshare-btn');
    await page.waitForTimeout(1800);

    const res = await page.evaluate(async () => {
      const host = document.getElementById('threshare-overlay-host');
      if (!host || !host.shadowRoot) return { error: 'no overlay' };
      const canvas = host.shadowRoot.querySelector('canvas');
      if (!canvas) return { error: 'no canvas' };
      let dataUrl = null;
      let err = null;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (e) {
        err = e.message;
      }
      return { w: canvas.width, h: canvas.height, dataUrl, err, overlayVisible: host.style.display !== 'none' };
    });

    if (res.error) throw new Error(res.error);
    say(`[5] 画布渲染: ${res.w}x${res.h} ${res.w > 0 ? 'OK' : 'FAIL'}`);
    say(`[6] 弹层可见: ${res.overlayVisible ? 'OK' : 'FAIL'}`);
    say(`[7] 导出可用（canvas 未污染）: ${res.dataUrl && !res.err ? 'OK' : 'FAIL ' + (res.err || '')}`);

    if (res.dataUrl) {
      const b64 = res.dataUrl.split('base64,')[1];
      const out = path.join(OUT, 'e2e-extension.png');
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      say(`[8] 已保存 ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
    }

    await page.screenshot({ path: path.join(OUT, 'e2e-overlay.png') });
    say(`[9] 弹层截图已保存`);

    const allOk =
      extCount > 0 &&
      maniErrors &&
      state.buttons === state.containers &&
      res.w > 0 &&
      res.overlayVisible &&
      !!res.dataUrl &&
      !res.err;
    say('');
    say(allOk ? '=== 全部通过 ===' : '=== 存在失败项 ===');
    process.exitCode = allOk ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.writeFileSync(path.join(ROOT, 'tests', 'e2e-report.txt'), report.join('\n'), 'utf8');
  }
})();
