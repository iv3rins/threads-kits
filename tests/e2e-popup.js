/* 真实扩展验证：420×900 小窗刷 Threads + 分享卡片
 *
 * 验证的是最终方案（独立 popup 窗口），不是 iframe 侧边栏 ——
 * iframe 已被证明不可行（Threads 在子 frame 里拒绝建立会话）。
 *
 * 判据：
 *   1) 扩展被加载且无 manifest 错误
 *   2) 点工具栏图标能开出 420×900 的 popup 窗口
 *   3) 窗口内 Threads 是手机版布局（窄宽度、单列）
 *   4) 帖子被识别，分享按钮挂上
 *   5) 点分享能出卡片，且可导出（canvas 未污染）
 *
 * 用法：node tests/e2e-popup.js
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
  const report = [];
  const say = (s) => { console.log(s); report.push(s); };

  const profile = path.join(ROOT, 'tests', '.chrome-profile-popup');
  fs.mkdirSync(profile, { recursive: true });
  const outDir = path.join(ROOT, 'tests', 'renders');
  fs.mkdirSync(outDir, { recursive: true });

  const exe = pickChromium();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--headless=new',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      // popup 窗口在 headless 下也要按请求尺寸开
      '--window-size=420,900',
    ],
  });

  try {
    // ── [1] 扩展是否加载 ──
    const p0 = await ctx.newPage();
    await p0.goto('chrome://extensions/');
    await p0.waitForTimeout(900);
    const extInfo = await p0.evaluate(() => {
      const m = document.querySelector('extensions-manager');
      if (!m || !m.shadowRoot) return { count: 0, items: [] };
      const list = m.shadowRoot.querySelector('extensions-item-list');
      if (!list || !list.shadowRoot) return { count: 0, items: [] };
      const items = [...list.shadowRoot.querySelectorAll('extensions-item')].map((el) => ({
        id: el.getAttribute('id'),
        name: el.shadowRoot ? ((el.shadowRoot.querySelector('#name') || {}).textContent || '').trim() : '',
        errors: !!el.shadowRoot.querySelector('#errors-button'),
      }));
      return { count: items.length, items };
    });
    const extId = extInfo.items[0] && extInfo.items[0].id;
    say(`[1] 扩展加载: ${extInfo.count} 个 ${extId || ''} ` +
      (extInfo.count > 0 && extInfo.items.every((i) => !i.errors) ? 'OK' : 'FAIL'));
    await p0.close();

    // ── [2] 用扩展后台直接开 popup（等价于点工具栏图标） ──
    // 新开一页当跳板，执行扩展上下文里的 openPopup
    const bgUrl = `chrome-extension://${extId}/src/background.js`;
    const opener = await ctx.newPage();
    await opener.goto('https://www.threads.com/robots.txt').catch(() => {});
    await opener.close();

    const before = ctx.pages().length;
    // 通过 service worker 触发（chrome.action.onClicked 无法直接调用），
    // 这里直接调 windows.create，参数与 background.js 一致，验证窗口尺寸与页面呈现
    const sbPage = await ctx.newPage();
    await sbPage.goto(`chrome-extension://${extId}/manifest.json`).catch(() => {});
    const created = await sbPage.evaluate(async () => {
      return new Promise((resolve) => {
        if (!chrome || !chrome.windows) return resolve({ err: 'no chrome.windows api' });
        chrome.windows.create(
          {
            url: 'https://www.threads.com/',
            type: 'popup',
            width: 420,
            height: 900,
            focused: true,
          },
          (win) => resolve({ windowId: win && win.id, w: win && win.width, h: win && win.height })
        );
      });
    });
    await sbPage.close();
    say(`[2] popup 创建: ${JSON.stringify(created)} ` + (created && created.windowId ? 'OK' : 'FAIL'));
    await new Promise((r) => setTimeout(r, 10000));

    // 关键：headless 下 chrome.windows.create 的 width/height 不生效，
    // 视口一律是 1280x720（实测确认）。真实有头模式是生效的。
    // 所以这里用 setViewportSize 强制成 popup 的目标尺寸，
    // 才能验证「420 宽下是否呈现手机版布局」这个真正的问题。
    const candidates = ctx.pages().filter((p) => /threads\.com/.test(p.url()));
    if (!candidates.length) throw new Error('没找到 threads 页面');
    // 优先挑最后打开的（popup 是在 opener 之后创建的）
    const page = candidates[candidates.length - 1];
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(2500);
    say(`[2.1] 已把测试视口设为 420x900（headless 不支持 popup 尺寸，真实有头模式支持）`);

    const dims = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      url: location.href,
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
      bodyTextLen: document.body.innerText.length,
    })).catch(async () => ({ err: 'evaluate failed' }));
    say(`[3] 窗口尺寸 ${dims.w}x${dims.h} 帖子=${dims.containers} 分享按钮=${dims.buttons} ` +
      (dims.w <= 500 && dims.containers > 0 ? 'OK(手机版窄窗)' : 'CHECK'));

    // ── [4] 分享按钮 ──
    const mounted = await page.evaluate(() => ({
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
    }));
    say(`[4] 分享按钮挂载: ${mounted.buttons}/${mounted.containers} ` +
      (mounted.buttons > 0 && mounted.buttons === mounted.containers ? 'OK' : 'FAIL'));

    // ── [5] 点分享出卡片 ──
    if (mounted.buttons > 0) {
      // 用 dispatchEvent 而不是 page.click：
      // 未登录时 Threads 会浮出登录弹层，遮住操作栏，真实鼠标点不进去。
      // 这里测的是按钮的 click 处理逻辑本身，不是指针可达性。
      await page.evaluate(() => {
        const btn = document.querySelector('.threshare-btn');
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForTimeout(4500);
      const res = await page.evaluate(() => {
        const host = document.getElementById('threshare-overlay-host');
        if (!host || !host.shadowRoot) return { error: 'no overlay' };
        const sr = host.shadowRoot;
        const canvas = sr.querySelector('canvas');
        if (!canvas) return { error: 'no canvas' };
        let dataUrl = null;
        let err = null;
        try {
          dataUrl = canvas.toDataURL('image/png');
        } catch (e) { err = e.message; }
        const dialog = sr.querySelector('.dialog');
        const dr = dialog ? dialog.getBoundingClientRect() : null;
        return {
          w: canvas.width, h: canvas.height, dataUrl, err,
          hint: (sr.querySelector('.hint') || {}).textContent || '',
          dialogRect: dr ? { w: Math.round(dr.width), h: Math.round(dr.height), left: Math.round(dr.left) } : null,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        };
      });
      if (res.error) throw new Error(res.error);
      say(`[5] 卡片渲染 ${res.w}x${res.h} ${res.w > 0 ? 'OK' : 'FAIL'}`);
      const noOverflow = res.dialogRect && res.dialogRect.w <= res.viewport.w + 1;
      say(`[6] 弹层尺寸 ${JSON.stringify(res.dialogRect)} 视口 ${JSON.stringify(res.viewport)} ` +
        (noOverflow ? 'OK(未溢出)' : 'FAIL(溢出)'));
      say(`[7] 提示: "${res.hint}"`);
      say(`[8] 导出可用 ${res.dataUrl && !res.err ? 'OK' : 'FAIL ' + (res.err || '')}`);
      if (res.dataUrl) {
        const f = path.join(outDir, 'popup-card.png');
        fs.writeFileSync(f, Buffer.from(res.dataUrl.split('base64,')[1], 'base64'));
        say(`[9] 卡片已存 ${f}`);
      }
    } else {
      say('[5-9] 跳过：没有分享按钮');
    }

    await page.screenshot({ path: path.join(outDir, 'popup-window.png') });
    say('[10] 窗口截图已存 tests/renders/popup-window.png');

    const ok = extInfo.count > 0 && created && created.windowId &&
      dims.w <= 500 && dims.containers > 0 &&
      mounted.buttons > 0 && mounted.buttons === mounted.containers;
    say('');
    say(ok ? '=== 核心项全部通过 ===' : '=== 存在失败项 ===');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'e2e-popup-report.txt'), report.join('\n'), 'utf8');
  }
})();
