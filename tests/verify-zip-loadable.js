/* 验证打包出的 zip 能被 Chrome 当作扩展加载
 *
 * 关键：不能只检查 zip 结构，必须让 Chrome 真的加载一次。
 * 做法：解压到临时目录 → --load-extension → 读 chrome://extensions
 *
 * 用法：node tests/verify-zip-loadable.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

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
  const say = (s) => {
    console.log(s);
    report.push(s);
  };
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    say(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const zipPath = path.join(ROOT, 'dist', `threshare-v${manifest.version}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.error('✗ 找不到 zip，先跑 node tools/pack-extension.js');
    process.exit(1);
  }
  say(`zip: ${path.basename(zipPath)}  ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`);
  say('');

  // ── 1) 解压（用 .NET 的 ZipFile，避免 PowerShell 参数问题）──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threshare-zip-'));
  const extractDir = path.join(tmpDir, 'ext');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execSync(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')"`,
      { stdio: 'pipe' }
    );
    say(`[1] 解压到 ${extractDir}`);
    check('压缩包可解压', true);
  } catch (e) {
    check('压缩包可解压', false, String(e.message).slice(0, 120));
    process.exit(1);
  }

  // ── 2) 目录结构检查 ──
  const hasManifest = fs.existsSync(path.join(extractDir, 'manifest.json'));
  check('manifest.json 在根目录', hasManifest, hasManifest ? '' : '（嵌套了子目录会导致 Chrome 加载失败）');
  if (!hasManifest) {
    say('\n解压后结构:');
    for (const e of fs.readdirSync(extractDir)) say('  ' + e);
    process.exit(1);
  }

  // ── 3) 真实加载 ──
  const profile = path.join(tmpDir, 'profile');
  const exe = pickChromium();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--headless=new',
      `--disable-extensions-except=${extractDir}`,
      `--load-extension=${extractDir}`,
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

    say(`[2] Chrome 读到: ${JSON.stringify(info)}`);
    check('Chrome 成功加载 zip 内的扩展', info.length > 0);
    check('无加载错误', info.every((i) => !i.hasErrors));
    check(
      '版本一致',
      info.some((i) => i.version === manifest.version),
      `页面=${info.map((i) => i.version).join(',')} manifest=${manifest.version}`
    );

    // ── 4) content script 真的注入成功 ──
    const extId = info[0] && info[0].id;
    if (extId) {
      const p2 = await ctx.newPage();
      // 用本地夹具伪装 threads.com，验证注入
      const fixture = path.join(ROOT, 'tests', 'dumps', 'post-page-1.html');
      if (fs.existsSync(fixture)) {
        const html = fs.readFileSync(fixture, 'utf8');
        await p2.route('https://www.threads.com/**', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`,
          });
        });
        await p2.goto('https://www.threads.com/@demo_alpha/post/Dfj4qy2lX7S', {
          waitUntil: 'domcontentloaded',
        });
        await p2.waitForTimeout(2500);
        const injected = await p2.evaluate(() => ({
          containers: document.querySelectorAll('[data-pressable-container]').length,
          buttons: document.querySelectorAll('.threshare-btn').length,
          style: !!document.getElementById('threshare-btn-style'),
        }));
        say(`[3] content script: ${JSON.stringify(injected)}`);
        check(
          'content script 注入并挂上分享按钮',
          injected.buttons > 0 && injected.buttons === injected.containers,
          `${injected.buttons}/${injected.containers}`
        );
      }
      await p2.close();
    }

    // ── 5) 图标可解码 ──
    if (extId) {
      const p3 = await ctx.newPage();
      await p3.goto(`chrome-extension://${extId}/manifest.json`);
      const iconOk = await p3.evaluate(async () => {
        const img = new Image();
        const ok = await new Promise((res) => {
          img.onload = () => res(img.naturalWidth === 128 && img.naturalHeight === 128);
          img.onerror = () => res(false);
          img.src = '/icons/icon-128.png';
        });
        return ok;
      });
      check('图标可从 zip 内加载', iconOk);
      await p3.close();
    }
  } catch (e) {
    check('真实加载流程', false, String(e.message).slice(0, 150));
  } finally {
    await ctx.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* Windows 可能占用，忽略 */
    }
  }

  say('');
  say(`结果: ${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'verify-zip-report.txt'), report.join('\n'), 'utf8');
  process.exitCode = fail ? 1 : 0;
})();
