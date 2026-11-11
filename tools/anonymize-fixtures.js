/* 匿名化测试夹具
 *
 * 为什么：tests/dumps/ 里的 HTML 是从真实帖子抓的，含 5 个真实账号的
 * 帖子内容、头像与配图的 CDN 链接。开源仓库不该带这些。
 *
 * 原则：只替换「可识别信息」，不动 DOM 结构。
 * 结构是测试的对象（选择器、层级、语义标记），内容不是。
 *
 * 替换内容：
 *   · 账号名 → demo_alpha / demo_beta ...
 *   · 头像/配图的 CDN URL → 同形状的占位 URL（保持 srcset 结构）
 *   · 正文 → 保留（它是测试数据的一部分，且已换成中性文案）
 *
 * 用法：node tools/anonymize-fixtures.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DUMPS = path.join(ROOT, 'tests', 'dumps');

// 真实账号 → 假名（保持长度量级，避免影响换行等行为）
const HANDLE_MAP = {
  'moore_demo': 'demo_alpha',
  'eat_love_photo': 'demo_beta',
  'knjuzzi_7414': 'demo_gamma',
  'vvn_tu': 'demo_delta',
  'barbaraaaaa.tw': 'demo_epsilon',
  // 回复区里出现过的账号
  'kimkatherine8964': 'user_one',
  'tru1y.11': 'user_two',
  'olenekkkk': 'user_three',
  'dolphin.1476660': 'user_four',
  'cute.diandian': 'user_five',
  'alicia.ttw': 'user_six',
  'liljworldee': 'user_seven',
  'waonfie': 'user_eight',
  'yyyi_xxue8': 'user_nine',
  'unicorn.3077678': 'user_ten',
  'ixi_xiix_': 'user_eleven',
  'woodendddesk': 'user_twelve',
  'fhvgdkb': 'user_thirteen',
  'chips0567': 'user_fourteen',
  'owl.03141592653': 'user_fifteen',
  'd0uzzzi': 'user_sixteen',
  'summerlee.eden': 'user_seventeen',
  'chunjung827': 'user_eighteen',
  'akbaradzani2': 'user_nineteen',
  'fisher.mp': 'user_twenty',
  'jinchumi_.photos': 'user_21',
  'umbral.camera': 'user_22',
  'keiyleeee': 'user_23',
  'ppsfxaudio': 'user_24',
  'rally071024': 'user_25',
  'claire222shy': 'user_26',
  'atnasgnaw': 'user_27',
  'cheyuanyou': 'user_28',
  'dmcjxisskdjejj': 'user_29',
  '7788ooxxtt': 'user_30',
  'junjiei6': 'user_31',
  'fushang86': 'user_32',
  'sunsonmiamia': 'user_33',
  'yannybbha': 'user_34',
  'narutaaaa11': 'user_35',
  'c_h_i1027': 'user_36',
  'raise.0207': 'user_37',
  'yuuuuu.313': 'user_38',
  'maribarsuk': 'user_39',
  'dirty_shake': 'user_40',
  'iaffe100': 'user_41',
  '_hczyy': 'user_42',
  'siclcao': 'user_43',
  '7yxns_': 'user_44',
  'zxc__9111024': 'user_45',
  'dian_0226': 'user_46',
  'cheenn.20': 'user_47',
  'togetoge.no.tamago': 'user_48',
  '77772chi': 'user_49',
  'wltea.913': 'user_50',
  'oojkuio_': 'user_51',
  'alex_a.ni__': 'user_52',
  'e.e_sharing': 'user_53',
  'honghongwuwu': 'user_54',
  'lanyue__1121': 'user_55',
  '_226079nyikm': 'user_56',
  'yulihong22': 'user_57',
  'hsi1007': 'user_58',
  'jasperbb2002': 'user_59',
};

/**
 * 把图片 URL 换成占位地址，但保持 URL 形状与**唯一性**。
 *
 * 唯一性很关键：collectThreadMedia 按 src 路径去重，
 * 如果把 8 张图都换成同一个占位 URL，去重后会只剩 1 张，
 * 多图测试就失去意义了（踩过）。
 */
function scrubImageUrls(html) {
  let n = 0;
  const nextId = () => `img${String(++n).padStart(3, '0')}`;

  return html
    .replace(/https:\/\/scontent\.cdninstagram\.com\/[^"'\s>]+/g, () =>
      `https://placehold.example/${nextId()}-avatar.jpg?_nc_cat=0&ig_cache_key=&ccb=0-0&_nc_sid=0&oe=00000000`
    )
    .replace(/https:\/\/instagram\.[a-z0-9-]+\.fna\.fbcdn\.net\/[^"'\s>]+/g, () =>
      `https://placehold.example/${nextId()}-media.jpg?stp=dst-jpg&_nc_cat=0&ccb=0-0&_nc_sid=0&oe=00000000`
    )
    .replace(/https:\/\/[a-z0-9-]*\.fbcdn\.net\/[^"'\s>]+/g, () =>
      `https://placehold.example/${nextId()}-media.jpg?stp=dst-jpg&_nc_cat=0&ccb=0-0&_nc_sid=0&oe=00000000`
    )
    .replace(/https:\/\/media1\.giphy\.com\/[^"'\s>]+/g, () =>
      `https://placehold.example/${nextId()}-emoji.gif`
    );
}

/** 替换账号名（含 URL、alt、显示名） */
function scrubHandles(html) {
  let out = html;
  // 按长度倒序替换，避免短名先替换掉长名的一部分
  const keys = Object.keys(HANDLE_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const v = HANDLE_MAP[k];
    // URL 路径 /@handle
    out = out.split('/@' + k).join('/@' + v);
    // alt="handle的头像"
    out = out.split(k + '的头像').join(v + '的头像');
    // 文本里独立出现（词边界用非字母数字包围）
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(?<![A-Za-z0-9_.@])' + esc + '(?![A-Za-z0-9_.])', 'g'), v);
  }
  return out;
}

/** 替换正文里可能识别到个人的专有内容（保守处理关键片段） */
function scrubText(html) {
  // 这里不做激进改写：正文本身是测试数据，替换掉就测不到换行/emoji 等行为。
  // 只处理明显的个人信息（手机号、邮箱形态）
  return html
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'redacted@example.com')
    .replace(/\b1[3-9]\d{9}\b/g, '13800000000');
}

let total = 0;
const files = fs.readdirSync(DUMPS).filter((f) => f.endsWith('.html'));
for (const f of files) {
  const p = path.join(DUMPS, f);
  const before = fs.readFileSync(p, 'utf8');
  let after = scrubImageUrls(before);
  after = scrubHandles(after);
  after = scrubText(after);

  const changed = before !== after;
  if (changed) {
    fs.writeFileSync(p, after, 'utf8');
    total++;
  }
  // 检查残留
  const leftover = Object.keys(HANDLE_MAP).filter((k) => after.includes(k));
  console.log(
    `${changed ? '✓' : '·'} ${f}  ${(after.length / 1024).toFixed(0)} KB` +
      (leftover.length ? `  残留账号: ${leftover.slice(0, 5).join(',')}` : '  无残留账号')
  );
}

console.log(`\n处理 ${total} 个文件`);
