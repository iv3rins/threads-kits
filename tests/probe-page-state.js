/* 诊断：真实页面为什么 0 个帖子
 *
 * 可能原因：登录墙、地区限制、页面还没渲染完、被判定为爬虫。
 * 把页面状态完整打出来，不靠猜。
 *
 * 用法：node tests/probe-page-state.js
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW = 'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core';
const { chromium } = require(fs.existsSync(LOCAL_PW) ? LOCAL_PW : 'playwright-core');

const ROOT = path.resolve(__dirname, '..');

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
  const profile = path.join(ROOT, 'tests', '.chrome-profile-state');
  fs.mkdirSync(profile, { recursive: true });

  const exe = pickChromium();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--headless=new', '--no-first-run',
      '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT],
  });

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 420, height: 900 });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 160));
  });

  await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
  for (const wait of [3000, 6000, 10000, 15000]) {
    await page.waitForTimeout(wait === 3000 ? 3000 : wait - 3000);
    const s = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
      textLen: document.body ? document.body.innerText.length : 0,
      head: document.body ? document.body.innerText.slice(0, 100).replace(/\n/g, ' | ') : '',
      hasTs: typeof window.TS !== 'undefined',
      hasStyle: !!document.getElementById('threshare-btn-style'),
    }));
    console.log(`[t=${wait}ms] ${JSON.stringify(s)}`);
  }

  await page.screenshot({ path: path.join(ROOT, 'tests', 'renders', 'state.png') });
  console.log('截图: tests/renders/state.png');
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
})();
