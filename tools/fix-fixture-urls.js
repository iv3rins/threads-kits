/* 修复夹具里重复的占位图片 URL
 *
 * 背景：anonymize-fixtures.js 第一版把所有 CDN 图都换成了同一个占位地址，
 * 导致 collectThreadMedia 按 src 去重后 8 张图只剩 1 张，多图测试失效。
 *
 * 这里给每个占位 URL 按出现顺序重新编号，恢复唯一性，
 * 并保持 srcset 的多档结构（同一张图的多档尺寸应共享同一个 id）。
 *
 * 用法：node tools/fix-fixture-urls.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DUMPS = path.join(ROOT, 'tests', 'dumps');

// 同一张图的"多档尺寸"在 srcset 里共享 ig_cache_key/stp 之外的同一基础名，
// 所以按「原始 URL 的身份」分组。现在的占位 URL 已经丢了原始身份，
// 只能按出现顺序：每个 src/srcset 属性算一个"图"，其中所有 URL 共享 id。
function renumber(html) {
  let counter = 0;
  // 匹配 src="..." 与 srcset="..." 里的占位 URL
  // srcset 内是 "url 640w,url 480w" 形式，整组共享一个 id
  const seen = new Map();

  // 先处理 srcset：整串替换
  html = html.replace(/srcset="([^"]*)"/g, (whole, content) => {
    const id = `m${String(++counter).padStart(3, '0')}`;
    const replaced = content.replace(
      /https:\/\/placehold\.example\/[^"\s,]+/g,
      (u, idx) => {
        // 保留尺寸后缀信息，只换基础名
        const q = u.includes('?') ? '?' + u.split('?')[1] : '';
        return `https://placehold.example/${id}-media.jpg${q}`;
      }
    );
    return `srcset="${replaced}"`;
  });

  // 再处理 src：每张图独立 id
  html = html.replace(/(\ssrc=")https:\/\/placehold\.example\/[^"]*(")/g, (whole, a, b) => {
    const id = `s${String(++counter).padStart(3, '0')}`;
    return `${a}https://placehold.example/${id}-img.jpg${b}`;
  });

  void seen;
  return { html, count: counter };
}

let total = 0;
for (const f of fs.readdirSync(DUMPS).filter((x) => x.endsWith('.html'))) {
  const p = path.join(DUMPS, f);
  const before = fs.readFileSync(p, 'utf8');
  const { html: after, count } = renumber(before);

  // 统计唯一性
  const ids = new Set(
    [...after.matchAll(/placehold\.example\/([a-z]\d+)-/g)].map((m) => m[1])
  );

  fs.writeFileSync(p, after, 'utf8');
  console.log(`✓ ${f}  重新编号 ${count} 处，唯一图片 id ${ids.size} 个`);
  total++;
}

console.log(`\n处理 ${total} 个文件`);
