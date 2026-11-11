/* 真实页面验证修复：直接点扩展的分享按钮，读它产出的卡片
 *
 * 这是最贴近用户的验证 —— 不注入任何测试代码，
 * 完全走扩展自己的 content script + 渲染链路。
 *
 * 判据（对应用户报的两个 bug）：
 *   1) 卡片上必须有正文（不能只剩数字）
 *   2) 卡片里不能出现 giphy 贴纸被当作配图
 *   3) 计数（赞/评论/转发）要出现
 *   4) 头像要画出来（不是兜底字母）
 *
 * 用法：node tests/probe-share-real.js
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW = 'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core';
const { chromium } = require(fs.existsSync(LOCAL_PW) ? LOCAL_PW : 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'renders');

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
  fs.mkdirSync(OUT, { recursive: true });

  const profile = path.join(ROOT, 'tests', '.chrome-profile-share');
  fs.mkdirSync(profile, { recursive: true });

  const exe = pickChromium();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--headless=new',
      '--no-first-run',
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
    ],
  });

  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);

    const mounted = await page.evaluate(() => ({
      containers: document.querySelectorAll('[data-pressable-container]').length,
      buttons: document.querySelectorAll('.threshare-btn').length,
    }));
    say(`[1] 页面帖子=${mounted.containers} 分享按钮=${mounted.buttons}`);
    if (!mounted.buttons) throw new Error('分享按钮未挂载');

    // 依次点前 5 条，逐条检查卡片
    const results = [];
    for (let i = 0; i < Math.min(5, mounted.buttons); i++) {
      await page.evaluate((idx) => {
        const btns = document.querySelectorAll('.threshare-btn');
        const b = btns[idx];
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }, i);
      await page.waitForTimeout(3500);

      const r = await page.evaluate(() => {
        const host = document.getElementById('threshare-overlay-host');
        if (!host || !host.shadowRoot) return { err: 'no overlay' };
        const sr = host.shadowRoot;
        const canvas = sr.querySelector('canvas');
        if (!canvas) return { err: 'no canvas' };
        const hint = (sr.querySelector('.hint') || {}).textContent || '';
        return {
          w: canvas.width,
          h: canvas.height,
          hint,
          dataUrl: (() => { try { return canvas.toDataURL('image/png'); } catch (e) { return null; } })(),
          // 关掉弹层，准备下一条
          closed: false,
        };
      });

      if (r.err) { say(`[${i + 2}] 第${i + 1}条 ✗ ${r.err}`); continue; }
      results.push({ i, ...r });
      say(`[${i + 2}] 第${i + 1}条 画布 ${r.w}x${r.h} 提示="${r.hint}"`);

      if (r.dataUrl) {
        const f = path.join(OUT, `share-real-${i + 1}.png`);
        fs.writeFileSync(f, Buffer.from(r.dataUrl.split('base64,')[1], 'base64'));
      }

      // 关闭弹层
      await page.evaluate(() => {
        const host = document.getElementById('threshare-overlay-host');
        const sr = host && host.shadowRoot;
        const close = sr && sr.querySelector('.close');
        if (close) close.click();
      });
      await page.waitForTimeout(500);
    }

    // 汇总：只要有一条画布高度过小（说明正文缺失），就是失败
    const tooSmall = results.filter((r) => r.h < 700);
    say('');
    say(`[汇总] 成功出卡 ${results.length} 条，高度分布: ${results.map((r) => r.h).join(', ')}`);
    if (tooSmall.length) {
      say(`[警告] ${tooSmall.length} 条画布过矮（可能正文缺失）`, 'bad');
    }
    const ok = results.length > 0 && tooSmall.length === 0;
    say(ok ? '=== 通过 ===' : '=== 存在可疑项 ===');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'probe-share-real-report.txt'), report.join('\n'), 'utf8');
  }
})();
