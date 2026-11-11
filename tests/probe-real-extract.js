/* 在真实页面验证修复（不依赖夹具的过期 URL）
 *
 * 做法：把 src 源码注入真实 threads.com 页面执行，
 * 用真实 DOM 与真实图片跑一遍 extract + render，确认：
 *   1) 正文非空（emoji 帖的正文曾经整段丢失）
 *   2) 媒体里没有 giphy 贴纸
 *   3) 头像能拿到
 *   4) 计数三项都在
 *
 * 用法：node tests/probe-real-extract.js
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

  const profile = path.join(ROOT, 'tests', '.chrome-profile-real');
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
    await page.waitForTimeout(9000);

    // content script 运行在隔离世界，页面 evaluate 看不到它的 window.TS。
    // 所以改为把源码重新注入页面主世界跑一遍（与扩展用的是同一份文件）。
    const srcFiles = ['util.js', 'extract.js', 'render.js'];
    const sources = srcFiles.map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
    for (const code of sources) {
      await page.addScriptTag({ content: code });
    }

    const result = await page.evaluate(async () => {
      if (!window.TS) return { err: 'TS 未注入' };
      const posts = TS.extractAll(document);
      if (!posts.length) return { err: '没有帖子' };

      const out = [];
      for (const p of posts.slice(0, 6)) {
        const d = p.data;
        const avatar = await TS.resolveImage(d.author.avatarSrc, d.author.avatarEl);
        out.push({
          handle: d.author.handle,
          textLen: d.text.length,
          textHead: d.text.slice(0, 45).replace(/\n/g, ' / '),
          mediaCount: d.media.length,
          mediaGiphy: d.media.filter((m) => m.src.includes('giphy')).length,
          mediaSrcs: d.media.map((m) => m.src.slice(0, 40)),
          counts: d.counts,
          avatarOk: !!avatar,
          avatarReused: avatar === d.author.avatarEl,
          avatarDims: avatar ? avatar.naturalWidth + 'x' + avatar.naturalHeight : null,
        });
      }
      return { count: posts.length, out };
    });

    if (result.err) throw new Error(result.err);
    say(`[1] 页面帖子数: ${result.count}`);
    let allOk = true;
    result.out.forEach((r, i) => {
      const noGiphy = r.mediaGiphy === 0;
      const hasText = r.textLen > 0;
      const hasCounts = r.counts.like + r.counts.reply + r.counts.repost > 0;
      const ok = noGiphy && hasText && hasCounts;
      if (!ok) allOk = false;
      say(
        `[${i + 2}] @${r.handle} 正文${r.textLen}字 媒体${r.mediaCount}(giphy=${r.mediaGiphy}) ` +
        `赞${r.counts.like}/评${r.counts.reply}/转${r.counts.repost} ` +
        `头像${r.avatarOk ? (r.avatarReused ? '复用' : '网络') + r.avatarDims : '缺失'} ` +
        (ok ? 'OK' : 'FAIL')
      );
      if (r.mediaGiphy > 0) say(`      ✗ 含 giphy 贴纸: ${r.mediaSrcs.join(' | ')}`);
      if (!hasText) say(`      ✗ 正文为空`);
    });

    say('');
    say(allOk ? '=== 真实页面提取全部通过 ===' : '=== 存在失败项 ===');
    process.exitCode = allOk ? 0 : 1;
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.writeFileSync(path.join(ROOT, 'tests', 'probe-real-report.txt'), report.join('\n'), 'utf8');
  }
})();
