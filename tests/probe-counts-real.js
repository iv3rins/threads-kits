/* 在真实 Threads 页面验证计数提取
 *
 * 直接注入 src 到页面主世界，与扩展用同一份代码。
 * 判据：actionRow 必须找到，「回复/转发/喜欢」三项必须出现在渲染结果里。
 *
 * 用法：node tests/probe-counts-real.js [url]
 */
const path = require('path');
const fs = require('fs');

const LOCAL_PW = 'C:\\Users\\iveri\\.config\\magpie\\mcp-npm\\1b491aa4633d80d1\\node_modules\\playwright-core';
const { chromium } = require(fs.existsSync(LOCAL_PW) ? LOCAL_PW : 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || 'https://www.threads.com/@iverins02';

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

  const profile = path.join(ROOT, 'tests', '.chrome-profile-counts');
  fs.mkdirSync(profile, { recursive: true });
  const exe = pickChromium();

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--headless=new', '--no-first-run'],
  });

  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);

    for (const f of ['util.js', 'extract.js', 'qrcode.js', 'render.js']) {
      await page.evaluate(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
    }

    const result = await page.evaluate(() => {
      if (!window.TS) return { err: 'TS 未注入' };
      const conts = [...document.querySelectorAll('[data-pressable-container]')].filter(
        (c) => c.querySelector('time')
      );
      return {
        total: conts.length,
        rows: conts.slice(0, 10).map((c) => {
          const p = TS.extractPost(c);
          const row = TS.actionRow(c);
          // 渲染出的文本里是否有三项统计
          const { plan } = TS.renderPost(p, null, { avatar: null, media: [] }, 1);
          const texts = plan.ops.filter((o) => o.kind === 'text').map((o) => o.text);
          return {
            head: (p.text || '').slice(0, 22).replace(/\n/g, ' '),
            hasRow: !!row,
            counts: p.counts,
            statLine: ['回复', '转发', '喜欢'].filter((t) => texts.includes(t)),
          };
        }),
      };
    });

    if (result.err) throw new Error(result.err);

    say(`页面: ${TARGET}`);
    say(`帖子数: ${result.total}\n`);
    for (const r of result.rows) {
      const c = r.counts;
      say(
        `  ${String(r.head).padEnd(24)} row=${r.hasRow ? 'Y' : 'N'}  ` +
          `赞${String(c.like).padEnd(6)} 回复${String(c.reply).padEnd(5)} 转发${String(c.repost).padEnd(5)}  ` +
          `统计行[${r.statLine.join(',')}]`
      );
    }

    const noRow = result.rows.filter((r) => !r.hasRow);
    const noStats = result.rows.filter((r) => r.statLine.length !== 3);
    say('');
    say(noRow.length === 0 ? '[1] ✓ 所有帖子都能定位 actionRow' : `[1] ✗ ${noRow.length} 条定位失败`);
    say(noStats.length === 0 ? '[2] ✓ 所有帖子统计行三项齐全' : `[2] ✗ ${noStats.length} 条统计行不全`);

    process.exitCode = noRow.length === 0 && noStats.length === 0 ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'probe-counts-report.txt'), report.join('\n'), 'utf8');
  }
})();
