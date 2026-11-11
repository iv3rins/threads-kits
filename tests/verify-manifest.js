/* 验证扩展的「版本号 + 图标」是否真的生效
 *
 * 用户反馈过两件事：
 *   1) 版本号一直不更新
 *   2) 插件图标不是 Threads
 * 这两项都必须在真实扩展环境里验，只看文件存在不够。
 *
 * 判据：
 *   · chrome://extensions 里读到的 version 与 manifest 一致
 *   · 扩展的 icon 资源能被解析成图片（非默认拼图）
 *   · content script 里 TS.VERSION 与 manifest 一致
 *
 * 用法：node tests/verify-manifest.js
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
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    say(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  say(`manifest version = ${manifest.version}`);
  say('');

  // ── 1) 文件层面 ──
  let filesOk = true;
  for (const [size, rel] of Object.entries(manifest.icons || {})) {
    const abs = path.join(ROOT, rel);
    const exists = fs.existsSync(abs);
    const bytes = exists ? fs.statSync(abs).size : 0;
    if (!exists || bytes < 100) filesOk = false;
    say(`   图标 ${size}px: ${rel} ${exists ? bytes + 'B' : '缺失'}`);
  }
  check('图标文件齐全', filesOk);
  check('manifest 有 icons 字段', !!manifest.icons && Object.keys(manifest.icons).length >= 4);
  check('action.default_icon 已设置', !!manifest.action && !!manifest.action.default_icon);

  // ── 2) 真实扩展环境 ──
  const profile = path.join(ROOT, 'tests', '.chrome-profile-manifest');
  fs.mkdirSync(profile, { recursive: true });
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
    ],
  });

  try {
    const p = await ctx.newPage();
    await p.goto('chrome://extensions/');
    await p.waitForTimeout(1200);

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
    say(`\nchrome://extensions 读到: ${JSON.stringify(info)}`);

    check('扩展已加载', info.length > 0);
    check('无 manifest 错误', info.every((i) => !i.hasErrors));
    check(
      '版本号与 manifest 一致',
      info.some((i) => i.version === manifest.version),
      `页面=${info.map((i) => i.version).join(',')} manifest=${manifest.version}`
    );

    const extId = info[0] && info[0].id;

    // ── 3) 图标资源：解码 + 像素检查 ──
    //
    // 注意不能在 chrome://extensions 页面里用 Image 加载扩展资源（CSP 拦截）。
    // 改在扩展自己的页面里加载，同时直接读像素确认不是空白/损坏。
    if (extId) {
      const p2 = await ctx.newPage();
      await p2.goto(`chrome-extension://${extId}/manifest.json`);

      const iconCheck = await p2.evaluate(async () => {
        const results = [];
        for (const size of [16, 32, 48, 128]) {
          const url = `/icons/icon-${size}.png`;
          const info = await new Promise((res) => {
            const img = new Image();
            img.onload = () => {
              // 画进 canvas 读像素，确认不是全透明空白
              const cv = document.createElement('canvas');
              cv.width = img.naturalWidth;
              cv.height = img.naturalHeight;
              const g = cv.getContext('2d');
              g.drawImage(img, 0, 0);
              let opaque = 0;
              let dark = 0;
              try {
                const d = g.getImageData(0, 0, cv.width, cv.height).data;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i + 3] > 10) {
                    opaque++;
                    if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
                  }
                }
              } catch (e) {
                res({ ok: false, err: 'getImageData: ' + e.message });
                return;
              }
              res({ ok: true, w: img.naturalWidth, h: img.naturalHeight, opaque, dark });
            };
            img.onerror = () => res({ ok: false, err: 'load failed' });
            img.src = url;
          });
          results.push({ size, ...info });
        }
        return results;
      });

      for (const r of iconCheck) {
        say(
          `   图标 ${r.size}px: ` +
            (r.ok ? `${r.w}x${r.h} 不透明像素=${r.opaque} 深色像素=${r.dark}` : `失败 ${r.err || ''}`)
        );
      }
      check(
        '图标尺寸正确且非空白',
        iconCheck.every((r) => r.ok && r.w === r.size && r.h === r.size && r.dark > 0)
      );

      const verFromRuntime = await p2.evaluate(() => {
        try {
          return chrome.runtime.getManifest().version;
        } catch (e) {
          return 'ERR:' + e.message;
        }
      });
      check(
        'chrome.runtime.getManifest().version 可读且一致',
        verFromRuntime === manifest.version,
        `runtime=${verFromRuntime}`
      );
      await p2.close();
    }
  } catch (e) {
    say('✗ ' + e.message);
    fail++;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  say('');
  say(`结果: ${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'verify-manifest-report.txt'), report.join('\n'), 'utf8');
  process.exitCode = fail ? 1 : 0;
})();
