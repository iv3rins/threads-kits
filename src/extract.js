/* Threshare · 帖子数据提取
 * Threads 的 class 是构建期混淆的哈希（x1a6qonq 之类），不能作为选择器依据。
 * 只依赖两类稳定锚点：
 *   1) 结构标记  data-pressable-container / data-pagelet
 *   2) 无障碍语义 <time datetime> <a href="/@user/post/..."> svg <title>
 */
(() => {
  const TS = (globalThis.TS = globalThis.TS || {});

  /** 帖子里夹带的按钮型 UI 文案，提取正文时要清掉 */
  const UI_TEXT =
    /^(翻译|查看翻译|更多|赞|评论|转发|分享|已赞|取消赞|隐藏|举报|复制链接|复制|嵌入|收藏|已收藏|关注|已关注|展开|显示更多|查看更多|收起|回复|关注中)$/;

  const svgTitle = (svg) => {
    const t = svg.querySelector('title');
    return (t && t.textContent ? t.textContent : svg.getAttribute('aria-label') || '').trim();
  };

  /**
   * 取元素内的文本。
   * 跳过子树里的按钮/图标，但根节点自身若是按钮仍要读 ——
   * 计数按钮本身就是 role=button，数字在它里面。
   */
  function visibleText(el) {
    const parts = [];
    const walk = (n, isRoot) => {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (tag.toLowerCase() === 'svg') return;
      if (!isRoot && n.getAttribute && n.getAttribute('role') === 'button') return;
      for (const c of n.childNodes) walk(c, false);
    };
    walk(el, true);
    return cleanText(parts.join(''));
  }

  function cleanText(raw) {
    let text = String(raw).replace(/\u00a0/g, ' ');
    // 去掉行内的 UI 按钮文案（"翻译" 往往直接拼在正文后面）
    text = text.replace(/\s*(翻译|查看翻译)\s*$/u, '');
    text = text.replace(/\s*(查看更多回复|查看全部回复|展开|收起)\s*$/u, '');

    // 行级清理：把「已置顶」「作者」「·」这类单独成行的标记删掉。
    // 它们和正文可能只隔空行（"作者\n\n是手機版…"），所以逐行判定，
    // 不能只处理紧邻开头的那一行。
    const MARKER_LINE = /^\s*(?:[·・]\s*)?(?:作者|已置顶|置顶|已编辑|翻译)\s*$/u;
    const kept = text.split('\n').filter((line) => !MARKER_LINE.test(line));
    text = kept.join('\n');

    // 顺带压掉因此产生的连续空行（保留单个空行作分段）
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.replace(/[ \t]+$/gm, '').trim();
  }

  /** 找出「帖子容器」：Threads 会给每条帖子的可点区域打 data-pressable-container */
  function postContainers(root = document) {
    const out = [];
    root.querySelectorAll('[data-pressable-container]').forEach((el) => {
      if (!el.querySelector('time') || !el.querySelector('a[href^="/@"]')) return;
      out.push(el);
    });
    return out;
  }

  /**
   * 从容器里读正文。
   *
   * 判据不是"文本最长的 div"，而是定位段落锚点 span[dir=auto]（Threads 用它包正文），
   * 但要排除三类污染：
   *   1) 作者名 / 时间：它们在 <a> 里
   *   2) 操作栏计数：在 actionRow 里
   *   3) 行内 UI 词：「已置顶」「作者」「·」这类标记也用了同样的 span，
   *      判据是它们太短、且整段就是 UI 词
   *
   * 再从锚点往上扩，扩到"第一个会引入 链接/时间/图片/按钮"的祖先之前为止。
   */
  /**
   * 判定一个 <img> 是不是「正文里的内联装饰」（emoji / 贴纸 / 小图标）。
   *
   * 这类图必须从两个地方都排除掉：
   *   1) 媒体列表 extractMedia —— 否则 emoji 会被当成一张配图
   *   2) 正文锚点 extractText —— 否则正文所在的 span 因为"含 img"被整个跳过，
   *      结果卡片上只剩计数数字，正文消失（踩过这个坑）
   *
   * 判据按可靠性排序：
   *   a) 结构签名（最可靠）：emoji/贴纸一定包在行内 <span> 里参与排版；
   *      帖子配图一定在 <div> 媒体容器里（带圆角、宽高约束）
   *   b) 渲染尺寸：真实页面上 emoji 只渲染 20-40px，配图上百像素
   *   c) 自然尺寸兜底
   *
   * 不能只靠 naturalWidth：giphy 贴纸自然尺寸可达 200px+，页面上却只渲染 30px。
   * 也不能只靠渲染尺寸：夹具/离屏时 getBoundingClientRect 全是 0。
   */
  const INLINE_MEDIA_MAX_PX = 64;
  const INLINE_TAGS = new Set(['SPAN', 'EM', 'STRONG', 'B', 'I', 'ABBR', 'SMALL']);

  function isInlineDecoration(img) {
    // a) 结构签名：行内元素里的图为装饰
    let host = img.parentElement;
    for (let d = 0; d < 2 && host; d++) {
      if (INLINE_TAGS.has(host.tagName)) return true;
      // 父级是「作者主页链接」才算装饰（头像/昵称区）。
      // 注意不能见到 <a> 就当装饰：单图帖子会把配图包进
      // a[href="/@user/post/xxx/media"] 里（点图看原图），
      // 那样会把唯一的一张配图误删 —— 单图不显示、多图正常的根因。
      if (host.tagName === 'A') {
        const href = host.getAttribute('href') || '';
        // 只在"指向作者主页"时判为装饰
        if (/^\/@[^/]+\/?$/.test(href)) return true;
      }
      host = host.parentElement;
    }

    // b) 渲染尺寸
    const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
    const w = (r && r.width) || 0;
    const h = (r && r.height) || 0;
    if (w > 0 && h > 0) return w <= INLINE_MEDIA_MAX_PX && h <= INLINE_MEDIA_MAX_PX;

    // c) 自然尺寸兜底（div 容器内、又拿不到渲染尺寸时）
    const nw = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10) || 0;
    const nh = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10) || 0;
    if (!nw || !nh) return false; // 尺寸全无：当成真媒体，避免正文被误删
    return nw <= INLINE_MEDIA_MAX_PX && nh <= INLINE_MEDIA_MAX_PX;
  }

  /** 元素内是否有「真媒体」（够大的图或视频），忽略内联 emoji/图标 */
  function hasRealMedia(el) {
    const imgs = [...el.querySelectorAll('img')];
    for (const img of imgs) {
      if (!isInlineDecoration(img)) return true;
    }
    return !!el.querySelector('video');
  }

  function extractText(container) {
    // 操作栏（含赞/评论图标的那行）以及所有按钮，都是正文的禁区
    const row = actionRow(container);

    // 帖子详情页里，主容器同时装着「排序 / 查看动态 / 回复框 / 回复列表」这些
    // 页面级控件。所以正文只能取「段落锚点自己的文本」，不能向上扩到祖先 ——
    // 上扩会把整块页面 UI 一起吃进来（踩过：卡片里出现"排序热门更多"）。
    const anchors = [...container.querySelectorAll('span[dir="auto"]')].filter((span) => {
      if (span.closest('a')) return false; // 作者名 / 时间链接
      if (row && row.contains(span)) return false; // 计数数字
      if (span.querySelector('time')) return false;
      // 不能因为"含 img"就排除 —— 正文里的 emoji 也是 img。
      // 只有真正的大图才是"这是媒体容器"的证据。
      if (hasRealMedia(span)) return false;
      // 排除交互控件区：排序栏、查看动态、回复输入框
      if (span.closest('[contenteditable="true"]')) return false;
      if (span.closest('textarea')) return false;
      if (isUiOnlyAnchor(span)) return false;
      const t = cleanText(span.textContent || '');
      const bare = t.replace(/\s/g, '');
      if (bare.length < 2) return false;
      // 整段就是 UI 词（「已置顶」「作者」「·」）→ 不是正文
      if (UI_TEXT.test(bare)) return false;
      // 纯数字（计数漏网）也不是正文
      if (/^[\d.,]+[万kwKW千亿]?$/.test(bare)) return false;
      return true;
    });
    if (!anchors.length) return '';

    /**
     * 锚点是否位于页面级控件里（不是帖子正文）。
     *
     * 判据：向上找最近的两层祖先，看有没有"按钮/选项/表单"这类语义。
     * 详情页的「排序 热门 更多」「查看动态」「回复xxx...」都是 role=button 或无 role 的按钮文本。
     */
    function isUiOnlyAnchor(span) {
      let el = span.parentElement;
      for (let d = 0; d < 4 && el && el !== container; d++) {
        const role = el.getAttribute && el.getAttribute('role');
        if (role === 'button' || role === 'tab' || role === 'menuitem' || role === 'option') return true;
        if (el.tagName === 'BUTTON') return true;
        // 表单类
        if (el.tagName === 'FORM') return true;
        if (el.getAttribute && el.getAttribute('aria-haspopup')) return true;
        el = el.parentElement;
      }
      return false;
    }

    /**
     * 从锚点向上扩，但**只在不会引入 UI 控件**时才扩。
     * 目的是合并多段正文（一个帖子多段落），不是收集整个容器。
     */
    const poisoned = (el) => {
      if (!el) return true;
      if (row && (el === row || el.contains(row))) return true;
      if (el.querySelector('time')) return true;
      if (el.querySelector('a[href^="/@"]')) return true;
      // 只有真媒体才阻止上扩；emoji 不阻止
      if (hasRealMedia(el)) return true;
      // 扩展后若带进任何按钮（含无 role 的 <button> 与 aria-haspopup 控件），就停
      if (el.querySelector('[role="button"]')) return true;
      if (el.querySelector('button')) return true;
      if (el.querySelector('[aria-haspopup]')) return true;
      // 带进输入框/编辑区，说明扩到了回复区
      if (el.querySelector('[contenteditable="true"], textarea')) return true;
      return false;
    };

    const blocks = anchors.map((span) => {
      let node = span;
      while (node.parentElement && node.parentElement !== container && !poisoned(node.parentElement)) {
        node = node.parentElement;
      }
      // 关键：只取锚点自己的文本，而不是 node 的 textContent。
      // node 可能仍包着少量 UI（例如段落外的间距/装饰），用锚点文本最干净。
      return { el: node, text: cleanText(span.textContent || '') };
    });

    // ── 归属判定：锚点必须是「这条帖子的正文」，不是容器里夹带的回复 ──
    //
    // 详情页的主容器会包含回复列表，回复文本同样是 span[dir=auto]。
    // 用操作栏做分界：正文在操作栏之上；操作栏之下的都是回复区。
    const rowRect = row ? row.getBoundingClientRect() : null;
    const canUsePosition = !!(rowRect && rowRect.top > 0 && rowRect.height > 0);
    if (canUsePosition) {
      const ownedBlocks = blocks.filter((b, i) => {
        const r = anchors[i].getBoundingClientRect();
        if (!r.height) return true; // 未布局就不判断，避免误杀
        return r.top < rowRect.top;
      });
      // 只有确实筛出了内容才应用，避免布局异常时把正文筛空
      if (ownedBlocks.length) {
        blocks.length = 0;
        blocks.push(...ownedBlocks);
      }
    }

    // 去重：去掉被更长的块完整包含的那些
    const uniq = [];
    for (const b of blocks) {
      const dup = uniq.some((o) => o.el === b.el);
      if (dup) continue;
      const contained = uniq.findIndex((o) => o.el.contains(b.el) && o.text.length >= b.text.length);
      if (contained >= 0) continue;
      // 反过来：新块包含了已有的，替换掉
      for (let i = uniq.length - 1; i >= 0; i--) {
        if (b.el.contains(uniq[i].el) && b.text.length >= uniq[i].text.length) uniq.splice(i, 1);
      }
      uniq.push(b);
    }

    const texts = uniq.map((u) => u.text).filter(Boolean);
    // 多段正文（串文）按 DOM 顺序拼起来
    const ordered = uniq
      .slice()
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((u) => u.text)
      .filter(Boolean);
    return (ordered.length ? ordered : texts).join('\n\n');
  }

  /**
   * 找帖子的作者头像。
   *
   * 不能写死成 `a[href^="/@"] img`：
   * 登录版里头像常常是独立 <div> 里的 <img>，**不在链接内**
   * （实测：inA=false、aHref=null，只有 alt 是"xxx的头像"）。
   * 用 alt 语义匹配最稳，再退回结构位置。
   */
  function findAvatar(container) {
    const imgs = [...container.querySelectorAll('img')];
    // 1) alt 以"的头像"/"avatar"结尾 —— 这是 Threads 自己给出的语义
    const byAlt = imgs.find((img) => {
      const alt = (img.getAttribute('alt') || '').trim();
      return /的头像$/.test(alt) || /\bavatar\b/i.test(alt) || /的头像/.test(alt);
    });
    if (byAlt) return byAlt;

    // 2) 结构：作者链接里的 img
    const inLink = imgs.find((img) => {
      const a = img.closest('a[href^="/@"]');
      return a && /^\/@[^/]+\/?$/.test(a.getAttribute('href') || '');
    });
    if (inLink) return inLink;

    // 3) 兜底：容器内第一张"小方图"（头像渲染通常是 32-80px 的接近正方形）
    const SQUARE_MIN = 24;
    const SQUARE_MAX = 96;
    const square = imgs.find((img) => {
      const r = img.getBoundingClientRect();
      const w = r.width || img.naturalWidth;
      const h = r.height || img.naturalHeight;
      if (!w || !h) return false;
      if (w < SQUARE_MIN || w > SQUARE_MAX) return false;
      return Math.abs(w - h) / Math.max(w, h) < 0.2; // 接近正方
    });
    return square || null;
  }

  function extractAuthor(container) {
    const links = [...container.querySelectorAll('a[href^="/@"]')];
    // 作者主页链接形如 /@name（不带 /post/）
    const profile = links.find((a) => /^\/@[^/]+\/?$/.test(a.getAttribute('href') || ''));
    let handle = profile
      ? profile.getAttribute('href').replace(/^\/@/, '').replace(/\/$/, '')
      : '';
    let displayName = '';
    if (profile) {
      const span = profile.querySelector('span[dir="auto"]');
      displayName = (span ? visibleText(span) : visibleText(profile)).split('\n')[0].trim();
    }

    const avatar = findAvatar(container);
    // 头像的 alt 是 "handle的头像"，可用来补 handle（登录版头像不在链接里时的兜底）
    if (!handle && avatar) {
      const m = (avatar.getAttribute('alt') || '').match(/^(.+)的头像$/);
      if (m) handle = m[1].trim();
    }

    return {
      handle,
      displayName: displayName || handle,
      avatarSrc: avatar ? bestImageSrc(avatar) : '',
      avatarAlt: avatar ? avatar.getAttribute('alt') || '' : '',
      // 页面上已经解码好的 img 元素本身。
      // CDN 地址带时效签名（oe=...），隔一段时间重新请求会 403，
      // 网络取不到时用它兜底。
      avatarEl: avatar || null,
    };
  }

  function extractTime(container) {
    const t = container.querySelector('time[datetime]');
    if (!t) return { iso: '', human: '' };
    const abbr = t.querySelector('abbr');
    const human = abbr
      ? (abbr.getAttribute('aria-label') || abbr.textContent || '').trim()
      : (t.textContent || '').trim();
    return { iso: t.getAttribute('datetime') || '', human };
  }

  /**
   * 操作栏：包含 赞 与 回复/评论 图标的一行。
   *
   * 注意要取「同时含多个按钮的 flex 行」，而不是单个按钮子树 ——
   * 单按钮里也可能有图标，但只有整行才同时具备 赞+回复+转发+分享。
   *
   * Threads 会把「评论」改叫「回复」（2026-11 实测），
   * 所以两种叫法都要认，否则整行匹配不到、计数全丢。
   */
  function actionRow(container) {
    const LIKE_RE = /赞|喜欢|like/i;
    const REPLY_RE = /回复|评论|reply|comment/i;
    const candidates = [...container.querySelectorAll('div')].filter((d) => {
      const titles = [...d.querySelectorAll('svg')].map(svgTitle);
      const hasLike = titles.some((t) => LIKE_RE.test(t));
      const hasReply = titles.some((t) => REPLY_RE.test(t));
      if (!hasLike || !hasReply) return false;
      // 必须是「一排按钮」：至少 3 个 role=button 直接或近似直接挂着
      return d.querySelectorAll('[role="button"]').length >= 3;
    });
    let best = null;
    for (const d of candidates) {
      let depth = 0;
      for (let n = d; n; n = n.parentElement) depth++;
      if (!best || depth > best.depth) best = { el: d, depth };
    }
    return best ? best.el : null;
  }

  /** 计数：操作栏里每个按钮的图标名 + 其后的数字 */
  function extractCounts(container) {
    const empty = { like: 0, reply: 0, repost: 0, share: 0 };
    const row = actionRow(container);
    if (!row) return empty;

    const items = [...row.querySelectorAll('[role="button"]')].map((btn) => {
      const title = [...btn.querySelectorAll('svg')].map(svgTitle).find(Boolean) || '';
      const label = (btn.getAttribute('aria-label') || '') + ' ' + title;
      // skipSelf:false —— 按钮自身就是 role=button，要读它里面的数字
      const numText = visibleText(btn);
      return { label, raw: numText, count: TS.parseCount(numText) };
    });

    const pick = (re) => {
      const hit = items.find((x) => re.test(x.label));
      return hit ? hit.count : 0;
    };
    // 「回复」是 Threads 2026-11 起的叫法，旧版叫「评论」，两者都认
    return {
      like: pick(/赞|喜欢|like/i),
      reply: pick(/回复|评论|reply|comment/i),
      repost: pick(/转发|引用|repost|rethread/i),
      share: pick(/分享|share/i),
    };
  }

  /**
   * 取图片的「最高分辨率真实地址」。
   *
   * 页面上 <img> 实际渲染的是小尺寸副本（currentSrc 常是 p240x240），
   * 直接拿 src 重绘会糊。srcset 里带着同一张图的多档尺寸，取最大那档。
   */
  function bestImageSrc(img) {
    const srcset = img.getAttribute('srcset') || '';
    if (srcset) {
      let best = null;
      let bestW = -1;
      // srcset 形如 "url 2268w, url 1080w"
      srcset.split(',').forEach((part) => {
        const m = part.trim().match(/^(\S+)\s+(\d+)(w|x)$/);
        if (!m) return;
        const w = parseInt(m[2], 10);
        if (w > bestW) {
          bestW = w;
          best = m[1];
        }
      });
      if (best) return best;
    }
    return img.getAttribute('src') || '';
  }

  /** 帖子内媒体（真实配图/视频封面），排除头像、图标与内联 emoji */
  function extractMedia(container) {
    const media = [];
    const avatar = findAvatar(container);

    container.querySelectorAll('img').forEach((img) => {
      if (img === avatar) return;
      // 只在「指向作者主页」的链接里跳过（头像/昵称区）。
      // 不能写成 closest('a[href^="/@"]')：单图帖的配图包在
      // a[href="/@user/post/xxx/media"] 里，那样会把唯一一张配图删掉。
      const link = img.closest('a');
      if (link) {
        const href = link.getAttribute('href') || '';
        if (/^\/@[^/]+\/?$/.test(href)) return;
      }
      // 内联 emoji、贴纸、小图标：不是配图
      if (isInlineDecoration(img)) return;
      const src = bestImageSrc(img);
      if (!src || src.startsWith('data:')) return;
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);
      media.push({
        type: 'image', src, w, h, alt: img.getAttribute('alt') || '',
        // 已解码的元素，网络失败时兜底复用
        el: img,
      });
    });

    container.querySelectorAll('video').forEach((v) => {
      const poster = v.getAttribute('poster') || '';
      if (poster) media.push({ type: 'image', src: poster, w: 0, h: 0, alt: '', el: null });
    });
    return media;
  }

  /** 帖子永久链接；夹具环境（非 threads 域）回落到线上绝对地址 */
  function extractPermalink(container) {
    const a = container.querySelector('a[href*="/post/"]');
    const href = a ? a.getAttribute('href') : '';
    if (href) {
      const onThreads = /(^|\.)threads\.(com|net)$/.test(location.hostname);
      const base = onThreads ? location.origin : 'https://www.threads.com';
      try {
        return new URL(href, base).href;
      } catch (e) {
        return base + href;
      }
    }
    return location.href;
  }

  /** 完整提取一条帖子 */
  TS.extractPost = function (container) {
    const author = extractAuthor(container);
    const time = extractTime(container);
    const permalink = extractPermalink(container);
    const post = {
      author,
      text: extractText(container),
      media: extractMedia(container),
      time,
      dateText: TS.formatDate(time.iso),
      counts: extractCounts(container),
      permalink,
    };
    if (!post.text && !post.media.length) return null;
    return post;
  };

  /** 页面上全部帖子 */
  TS.extractAll = function (root = document) {
    return postContainers(root)
      .map((el) => ({ el, data: TS.extractPost(el) }))
      .filter((x) => x.data);
  };

  /**
   * 收集整串（含续帖）的媒体，按出现顺序去重。
   *
   * 很多人把图贴在 2/2 里，只取主帖会漏。渲染层只画前 4 张，
   * 多出的叠 +N 角标，所以这里可以放心把全部收下来。
   */
  TS.collectThreadMedia = function (thread) {
    const out = [];
    const seen = new Set();
    for (const seg of thread || []) {
      for (const m of seg.media || []) {
        if (!m || !m.src) continue;
        // 用 src 的路径部分去重：同一张图可能因 query 不同出现两次
        const key = m.src.split('?')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
    }
    return out;
  };

  /**
   * 找出「同作者串文」：主帖下方连续的、作者相同的帖子。
   *
   * 光看「同作者 + 紧随其后」不够 —— 在个人主页上整页都是同一个作者，
   * 那样会把 4 条互不相干的帖子当成一条串文合并（踩过的 bug）。
   *
   * 真正的串文（1/2、2/2）是作者**连续写完**的，发布时间彼此非常接近；
   * 主页上的独立帖则相隔数小时到数天。所以加时间近邻判据。
   *
   * 同时要求：两条帖子之间不能夹着回复区（Threads 会插在中间）。
   */
  // 真串文的时间窗口。实测：同一次写作的两段相差 3-4 分钟；
  // 主页独立帖至少相差数小时。取 30 分钟留足余量。
  const THREAD_TIME_WINDOW_MS = 30 * 60 * 1000;

  TS.extractThread = function (container) {
    const main = TS.extractPost(container);
    if (!main) return [];

    const all = [...document.querySelectorAll('[data-pressable-container]')];
    const idx = all.indexOf(container);
    if (idx < 0) return [main];

    // 主帖发布时间（毫秒）。拿不到时间就无法判断，保守地当作单帖。
    const mainTime = main.time && main.time.iso ? Date.parse(main.time.iso) : NaN;
    if (!isFinite(mainTime)) return [main];

    const chain = [main];
    let prevTime = mainTime;

    for (let i = idx + 1; i < all.length; i++) {
      const el = all[i];
      const next = TS.extractPost(el);
      if (!next) break;

      // 1) 必须同作者
      if (next.author.handle !== main.author.handle) break;

      // 2) 必须有实质内容
      if (!next.text && !next.media.length) break;

      // 3) 时间必须靠近「上一条」，而不是靠近主帖 ——
      //    串文是一路写下去的，逐条邻近即可，不必都贴近第一条。
      const t = next.time && next.time.iso ? Date.parse(next.time.iso) : NaN;
      if (!isFinite(t)) break;
      if (Math.abs(t - prevTime) > THREAD_TIME_WINDOW_MS) break;

      chain.push(next);
      prevTime = t;
      if (chain.length >= 8) break; // 防御：避免把整个时间线吃进来
    }

    return chain;
  };

  // content.js 需要复用
  TS.actionRow = actionRow;
  TS.postContainers = postContainers;
  TS.visibleText = visibleText;
  TS.isInlineDecoration = isInlineDecoration;
})();
