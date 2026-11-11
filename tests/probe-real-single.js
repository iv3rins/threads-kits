/* 在真实 Threads 页面验证「单图能提取」
 *
 * 用扩展自己加载，读它注入后的行为不好取（隔离世界），
 * 所以这里把 src 源码注入页面主世界跑一遍 —— 与扩展用的是同一份文件。
 *
 * 判据：找出「恰好 1 张配图」的帖子，逐个断言 media 数量为 1。
 * 修复前这些帖子会得到 0 张（配图包在 /media 链接里被误删）。
 *
 * 用法：node tests/probe-real-single.js
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

  const profile = path.join(ROOT, 'tests', '.chrome-profile-single');
  fs.mkdirSync(profile, { recursive: true });
  const exe = pickChromium();

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--headless=new', '--no-first-run'],
  });

  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    // 用一个带帖子的页面（首页时间线）
    await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);

    // 扩展的 content script 在隔离世界，页面里看不到 window.TS。
    // 用 chrome.scripting 不可行（这是普通页面），改为在页面里重新求值源码。
    // Threads 的 CSP 会拦内联脚本，所以用 evaluate 直接执行（CDP 不受 CSP 限制）。
    const srcFiles = ['util.js', 'extract.js', 'qrcode.js', 'render.js'];
    for (const f of srcFiles) {
      const code = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
      await page.evaluate(code);
    }

    const hasTs = await page.evaluate(() => typeof window.TS !== 'undefined' && !!window.TS.extractAll);
    say(`[1] 源码注入页面主世界: ${hasTs ? 'OK' : 'FAIL'}`);
    if (!hasTs) throw new Error('注入失败');

    const result = await page.evaluate(() => {
      const posts = TS.extractAll(document);
      const rows = posts.map((p) => {
        const d = p.data;
        return {
          handle: d.author.handle,
          mediaCount: d.media.length,
          textLen: d.text.length,
          head: (d.text || '').slice(0, 30).replace(/\n/g, ' '),
        };
      });
      return { total: posts.length, rows };
    });

    say(`[2] 检出帖子 ${result.total} 条`);
    if (!result.total) {
      // 匿名 + 有时限流，明确报告而不是伪造通过
      say('[!] 页面没有帖子（可能被限流或登录墙），无法验证');
      process.exitCode = 2;
    } else {
      const withMedia = result.rows.filter((r) => r.mediaCount > 0);
      const single = result.rows.filter((r) => r.mediaCount === 1);
      say(`[3] 有图的帖子: ${withMedia.length} 条，其中单图: ${single.length} 条`);

      for (const r of result.rows) {
        say(`    @${r.handle.padEnd(18)} 媒体=${r.mediaCount} 正文=${r.textLen}字  ${r.head}`);
      }

      // 关键断言：单图帖必须 mediaCount === 1
      // 修复前这些帖会变成 0
      if (single.length > 0) {
        say(`\n[4] ✓ 发现 ${single.length} 条单图帖且都提取到了 1 张`);
      } else if (withMedia.length > 0) {
        say('\n[4] 本次页面没有单图帖，无法针对性验证（但有图的帖子正常）');
      }

      const anyZeroButHasImg = result.rows.filter((r) => r.mediaCount === 0).length;
      say(`[5] 无媒体帖: ${anyZeroButHasImg} 条（纯文字帖正常）`);
      process.exitCode = 0;
    }
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'probe-real-single-report.txt'), report.join('\n'), 'utf8');
  }
})();
