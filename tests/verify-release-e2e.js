/* 验证「从 GitHub Release 下载回来的 zip」能被 Chrome 加载
 *
 * 这是最终的端到端检查：不测本地构建产物，
 * 测的是用户实际会下载到的那个文件。
 *
 * 用法：node tests/verify-release-e2e.js <解压目录>
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW = 'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core';
const { chromium } = require(fs.existsSync(LOCAL_PW) ? LOCAL_PW : 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const extDir = process.argv[2];
if (!extDir || !fs.existsSync(path.join(extDir, 'manifest.json'))) {
  console.error('用法: node tests/verify-release-e2e.js <解压后的扩展目录>');
  process.exit(1);
}

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
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  console.log(`扩展目录: ${extDir}`);
  console.log(`版本: ${manifest.version}\n`);

  const profile = path.join(extDir, '..', '.profile-release');
  const exe = pickChromium();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--headless=new',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const p = await ctx.newPage();
    await p.goto('chrome://extensions/');
    await p.waitForTimeout(1500);
    const info = await p.evaluate(() => {
      const m = document.querySelector('extensions-manager');
      const list = m && m.shadowRoot && m.shadowRoot.querySelector('extensions-item-list');
      const items = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('extensions-item')] : [];
      return items.map((el) => ({
        id: el.getAttribute('id'),
        name: ((el.shadowRoot && el.shadowRoot.querySelector('#name') || {}).textContent || '').trim(),
        version: ((el.shadowRoot && el.shadowRoot.querySelector('#version') || {}).textContent || '').trim(),
        hasErrors: !!el.shadowRoot.querySelector('#errors-button'),
      }));
    });
    console.log(`Chrome 读到: ${JSON.stringify(info)}\n`);

    check('Chrome 加载成功', info.length > 0);
    check('无加载错误', info.every((i) => !i.hasErrors));
    check('版本正确', info.some((i) => i.version === manifest.version));

    // content script 注入测试
    const fixture = path.join(ROOT, 'tests', 'dumps', 'post-page-1.html');
    if (fs.existsSync(fixture)) {
      const p2 = await ctx.newPage();
      const html = fs.readFileSync(fixture, 'utf8');
      await p2.route('https://www.threads.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`,
        });
      });
      await p2.goto('https://www.threads.com/@demo_alpha/post/Dfj4qy2lX7S', { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(2500);

      const injected = await p2.evaluate(() => ({
        buttons: document.querySelectorAll('.threshare-btn').length,
        hasTS: typeof window.TS !== 'undefined',
      }));
      check('分享按钮已挂载', injected.buttons > 0, `${injected.buttons} 个`);

      // 点一下出卡片
      if (injected.buttons > 0) {
        await p2.evaluate(() => {
          document.querySelector('.threshare-btn').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
          );
        });
        await p2.waitForTimeout(4000);
        const card = await p2.evaluate(() => {
          const host = document.getElementById('threshare-overlay-host');
          const cv = host && host.shadowRoot && host.shadowRoot.querySelector('canvas');
          if (!cv) return { ok: false };
          let exportable = true;
          try {
            cv.toDataURL('image/png');
          } catch (e) {
            exportable = false;
          }
          return { ok: true, w: cv.width, h: cv.height, exportable };
        });
        check('卡片能渲染', card.ok, card.ok ? `${card.w}x${card.h}` : '');
        check('可导出 PNG（未污染）', card.exportable === true);
      }
      await p2.close();
    }
  } catch (e) {
    check('端到端流程', false, String(e.message).slice(0, 150));
  } finally {
    await ctx.close();
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})();
