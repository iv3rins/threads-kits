/* Threshare · 公共工具
 * 无依赖，可在 content script 与本地 harness 中共用。
 */
(() => {
  const TS = (globalThis.TS = globalThis.TS || {});

  // 版本号：优先读扩展 manifest（唯一事实来源），避免手写副本忘了同步。
  // 页面内没有 chrome.runtime 时（本地 harness）回退到占位值。
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      TS.VERSION = chrome.runtime.getManifest().version;
    }
  } catch (e) {
    /* 忽略：非扩展环境 */
  }
  if (!TS.VERSION) TS.VERSION = 'dev';

  // 标题/元信息用无衬线（黑体）；正文用衬线（宋体系）
  //
  // 字重齐全的族要排在前面：本机装了 "Source Han Serif SC Heavy"，
  // 若把族名写成 "Source Han Serif SC" 让浏览器按族名回退，400 会落到 Heavy 上，
  // 正文就会异常粗重。Noto Serif SC 有完整 Light/Regular/Medium/SemiBold/Black，故置顶。
  TS.SANS =
    '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", ' +
    '"Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
  TS.SERIF =
    '"Noto Serif SC", "Songti SC", "STSong", "Source Han Serif SC", "SimSun", ' +
    'Georgia, "Times New Roman", serif';

  /** "1.2万" / "1,234" / "12K" / "736" → number */
  TS.parseCount = function (raw) {
    if (!raw) return 0;
    const s = String(raw).trim().replace(/[,\s]/g, '');
    const m = s.match(/([\d.]+)\s*(万|w|k|m|千|亿)?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const unit = (m[2] || '').toLowerCase();
    const mult = { '万': 1e4, w: 1e4, '千': 1e3, k: 1e3, m: 1e6, '亿': 1e8 }[unit] || 1;
    return Math.round(n * mult);
  };

  /** 大数字回落成中文习惯写法：736 / 1.2万 */
  TS.formatCount = function (n) {
    if (!n) return '';
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  };

  /** ISO → "2026年11月10日 20:16" */
  TS.formatDate = function (iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /** 驼峰安全的 DOM 注入标记 */
  TS.marked = (el, key) => !!(el && el.dataset && el.dataset[key]);

  /**
   * 逐字符/逐词折行：CJK 按字断，拉丁按词断，超长串强断。
   * 返回视觉行数组（已去尾空白）。
   */
  TS.wrapText = function (measure, text, maxWidth) {
    const lines = [];
    const paras = String(text).split('\n');
    for (const para of paras) {
      if (!para.trim()) {
        lines.push('');
        continue;
      }
      // 词 / 空白 / 单字 三类 token
      const tokens = para.match(/[A-Za-z0-9@#_\-.,:;!?'"()[\]{}/%&+=~`|\\^$*]+|\s+|[\s\S]/gu) || [];
      let line = '';
      for (const tok of tokens) {
        const candidate = line + tok;
        if (line.trim() !== '' && measure(candidate) > maxWidth) {
          lines.push(line.replace(/\s+$/, ''));
          line = tok.replace(/^\s+/, '');
        } else {
          line = candidate;
        }
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  };

  /** 曲率更连续的圆角（superellipse），n 越大越接近方角；n=2 即正圆角 */
  TS.squirclePath = function (ctx, x, y, w, h, r, n = 3.2) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r <= 0.01) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      return;
    }
    const seg = 20;
    const cx1 = x + r, cy1 = y + r;
    const cx2 = x + w - r, cy2 = y + r;
    const cx3 = x + w - r, cy3 = y + h - r;
    const cx4 = x + r, cy4 = y + h - r;
    const k = 2 / n;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI / 2;
      ctx.lineTo(cx2 + r * Math.pow(Math.sin(t), k), cy2 - r * Math.pow(Math.cos(t), k));
    }
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI / 2;
      ctx.lineTo(cx3 + r * Math.pow(Math.cos(t), k), cy3 + r * Math.pow(Math.sin(t), k));
    }
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI / 2;
      ctx.lineTo(cx4 - r * Math.pow(Math.sin(t), k), cy4 + r * Math.pow(Math.cos(t), k));
    }
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI / 2;
      ctx.lineTo(cx1 - r * Math.pow(Math.cos(t), k), cy1 - r * Math.pow(Math.sin(t), k));
    }
    ctx.closePath();
  };

  /**
   * 把页面上已经解码好的 <img> 转成可绘制对象。
   *
   * 用途：Threads 的图片地址带时效签名（oe=6A...），页面放久了重新请求会 403，
   * 而浏览器里已解码的元素仍然可用。
   *
   * ⚠ 陷阱：页面上的 <img> 大多**不是**以 CORS 模式加载的。
   * 直接把它 drawImage 进 canvas 会把 canvas 标成 tainted，
   * toDataURL 抛 "Tainted canvases may not be exported"，导出彻底失效。
   * 所以只有在明确拿到 CORS 证明时才复用 —— 见 canReuseSafely()。
   */
  TS.adoptImage = function (el) {
    if (!el) return null;
    if (!el.complete || !el.naturalWidth || !el.naturalHeight) return null;
    return el;
  };

  /**
   * 页面元素能否安全地画进 canvas。
   *
   * 判据：用同一 URL 做一次 CORS 探测。能拿到 CORS 副本说明服务器允许跨域，
   * 此时页面元素（同源 URL）的像素也视为可导出 —— 不做这个探测就直接复用
   * 会污染 canvas（踩过，导致导出整体失效）。
   */
  const corsProbeCache = new Map();
  TS.canReuseSafely = function (el, url) {
    if (!el || !url) return Promise.resolve(false);
    if (corsProbeCache.has(url)) return corsProbeCache.get(url);
    const p = new Promise((resolve) => {
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
    corsProbeCache.set(url, p);
    return p;
  };

  /** 图片加载：优先 CORS 干净副本（否则 canvas 会被污染，无法导出） */
  TS.loadImage = function (url, timeout = 12000) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeout);
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        clearTimeout(timer);
        finish(img);
      };
      img.onerror = () => {
        // 退回不带 CORS 的加载（可能污染 canvas，导出环节会兜底报错）
        const plain = new Image();
        plain.onload = () => {
          clearTimeout(timer);
          finish(plain);
        };
        plain.onerror = () => {
          clearTimeout(timer);
          finish(null);
        };
        plain.src = url;
      };
      img.src = url;
    });
  };

  /**
   * 取一张可安全绘制的图。
   *
   * 顺序很关键：**先走网络拿 CORS 副本**，拿不到才退回复用页面元素。
   * 反过来会污染 canvas（页面里的 img 多数没带 CORS），导出直接失效。
   * 只有在网络失败（常见于签名过期 403）时才复用已解码元素 ——
   * 此时宁可图能显示，导出时由调用方兜底提示。
   */
  TS.resolveImage = async function (url, el) {
    const fresh = await TS.loadImage(url);
    if (fresh) return fresh;
    return TS.adoptImage(el);
  };

  /**
   * 并发受限的批量加载。
   * 一条帖子可能有 8-10 张高清图，全部并发会把带宽和内存打满。
   * @param {Array<string>} urls
   * @param {number} concurrency
   * @param {Array<HTMLImageElement>} els 对应的页面元素（网络失败时兜底复用）
   */
  TS.loadImages = async function (urls, concurrency = 4, els = null) {
    const out = new Array(urls.length).fill(null);
    let cursor = 0;
    const workers = new Array(Math.min(concurrency, urls.length || 1)).fill(0).map(async () => {
      while (cursor < urls.length) {
        const i = cursor++;
        const fresh = await TS.loadImage(urls[i]);
        out[i] = fresh || TS.adoptImage(els && els[i]);
      }
    });
    await Promise.all(workers);
    return out;
  };
})();
