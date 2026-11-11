/* 在真实个人主页验证「串文误合并」已修复
 *
 * 用 browser-skill 的会话拿不到 window.TS（content script 在隔离世界），
 * 所以这里把源码注入页面主世界跑一遍，与扩展用同一份文件。
 *
 * 判据：个人主页上点任意一条帖子的分享，
 *   extractThread 必须只返回 1 条（修复前会返回 2-4 条）。
 *
 * 用法：node tests/probe-profile-thread.js
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
  const say = (s) => {
    console.log(s);
    report.push(s);
  };

  const profile = path.join(ROOT, 'tests', '.chrome-profile-profile');
  fs.mkdirSync(profile, { recursive: true });
  const exe = pickChromium();

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--headless=new', '--no-first-run'],
  });

  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('https://www.threads.com/@iverins02', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);

    // 注入源码到主世界
    const files = ['util.js', 'extract.js', 'qrcode.js', 'render.js'];
    for (const f of files) {
      await page.evaluate(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
    }

    const result = await page.evaluate(() => {
      if (!window.TS || !TS.extractThread) return { err: 'TS 未注入' };
      const conts = [...document.querySelectorAll('[data-pressable-container]')];
      if (!conts.length) return { err: '页面没有帖子' };

      const rows = conts.map((c, i) => {
        const p = TS.extractPost(c);
        let thread = [];
        let err = null;
        try {
          thread = TS.extractThread(c);
        } catch (e) {
          err = e.message;
        }
        return {
          i,
          handle: p ? p.author.handle : null,
          time: p && p.time ? p.time.iso : null,
          textLen: p ? p.text.length : 0,
          threadLen: thread.length,
          threadTimes: thread.map((t) => t.time.iso),
          err,
        };
      });
      return { total: conts.length, rows };
    });

    if (result.err) throw new Error(result.err);

    say(`[1] 主页帖子数: ${result.total}`);
    say('');
    for (const r of result.rows) {
      say(`  #${r.i} @${r.handle}  ${String(r.time).slice(0, 16)}  正文${r.textLen}字  →  extractThread = ${r.threadLen} 条`);
      if (r.threadLen > 1) {
        say(`      合并了: ${r.threadTimes.map((t) => String(t).slice(11, 19)).join(', ')}`);
      }
    }

    // 关键断言：主页上每条都应该是 1
    const multi = result.rows.filter((r) => r.threadLen > 1);
    say('');
    if (multi.length === 0) {
      say(`[2] ✓ 全部 ${result.rows.length} 条都只取自己（修复生效）`);
    } else {
      say(`[2] ✗ ${multi.length} 条仍被误合并`);
      process.exitCode = 1;
    }

    // 反向验证：仍能识别真串文（用夹具页面单独测，见 verify-thread-detect.js）
    say('[3] 真串文识别由 tests/verify-thread-detect.js 覆盖');
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'probe-profile-report.txt'), report.join('\n'), 'utf8');
  }
})();
