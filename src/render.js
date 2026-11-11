/* Threshare · X 风格卡片渲染器
 *
 * 视觉规则（对齐 X 的帖子卡片）：
 *   · 卡片 G2 连续圆角（superellipse，不是正圆弧）
 *   · 作者名 = 黑体加粗（无衬线 700）
 *   · 正文   = 衬线体，行距放宽
 *
 * 结构：layout() 只算坐标、产出绘制指令 → paint() 落到 canvas。
 * 预览与导出共用同一条路径，不存在"预览好看、导出走样"。
 */
(() => {
  const TS = (globalThis.TS = globalThis.TS || {});

  /** 主题令牌 —— 调样式只改这里 */
  const BASE_THEME = {
    // 卡片
    width: 640,
    padding: 36,
    g2: { radius: 30, curvature: 3.2 }, // curvature 越大越接近方角；2 = 正圆弧
    mediaRadius: 18,
    mediaGap: 4,
    mediaDots: true, // 多图时在下方画轮播指示点
    avatar: 56,

    // 卡片右上角的品牌标记
    brandMark: {
      size: 26,          // 标记尺寸（CSS px）
      color: '#0F1419',
      opacity: 0.85,
    },

    // 二维码
    qr: {
      size: 108,         // 边长（CSS px）。比之前大，模块更清晰、更易扫
      quiet: 2,          // 静区模块数（四周留白，扫码器需要）
      // 中心留空：微信式，留空处可放任意图标/图片。
      // H 级纠错（30% 容错）下实测 40% 仍可解码（tests/verify-qr-hole.js）。
      // 取 26%：足够放一个清晰图标，且余量充足。
      holeRatio: 0.26,
      holeRadius: 0.18,  // 留空区圆角（占留空边长的比例）
      fgColor: '#0F1419',
      bgColor: '#FFFFFF',
      // 中心放什么：'threads' 画 Threads 标记；传 dataUrl 则贴图
      center: 'threads',
      centerFill: 0.72,  // 图标占留空区的比例
    },

    // 画布外框：给 G2 圆角留出可见的边
    frame: {
      enabled: true,
      padding: 34,
      background: '#EEF1F3',
      backgroundTo: '#E3E8EB', // 竖向渐变终点，留空则纯色
      shadow: { color: 'rgba(15, 20, 25, 0.16)', blur: 42, offsetY: 12 },
    },

    colors: {
      card: '#FFFFFF',
      ink: '#0F1419',
      inkSoft: '#536471',
      inkFaint: '#8B98A5',
      line: '#EFF3F4',
      lineStrong: '#CFD9DE',
      accent: '#1D9BF0',
      // 串文续帖块的底色：极淡的品牌色，既区分出"这是接续的另一条"，
      // 又不至于抢正文
      threadBg: '#F7F9F9',
    },

    font: {
      name: { size: 20, weight: 700, family: 'sans' },
      handle: { size: 16, weight: 400, family: 'sans' },
      body: { size: 23, weight: 400, family: 'serif', lineHeight: 1.66, letterSpacing: 0.2 },
      stat: { size: 14, weight: 600, family: 'sans' },
      statNum: { size: 17, weight: 700, family: 'sans' },
      brand: { size: 12, weight: 700, family: 'sans', letterSpacing: 2 },
      link: { size: 13, weight: 400, family: 'sans' },
      badge: { size: 20, weight: 700, family: 'sans' },
    },
  };

  TS.BASE_THEME = BASE_THEME;

  function deepMerge(a, b) {
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {};
        deepMerge(a[k], b[k]);
      } else a[k] = b[k];
    }
    return a;
  }

  function resolveTheme(theme) {
    const t = JSON.parse(JSON.stringify(BASE_THEME));
    if (theme) deepMerge(t, theme);
    return t;
  }

  function fontStr(spec) {
    const fam = spec.family === 'serif' ? TS.SERIF : TS.SANS;
    return `${spec.weight || 400} ${spec.size}px ${fam}`;
  }

  let _mctx = null;
  function measurer() {
    if (!_mctx) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      _mctx = c.getContext('2d');
    }
    return _mctx;
  }

  function textMeasure(spec, letterSpacing = 0) {
    const ctx = measurer();
    ctx.font = fontStr(spec);
    return (s) => ctx.measureText(s).width + Math.max(0, [...s].length - 1) * letterSpacing;
  }

  // ── 布局 ────────────────────────────────────────────────────────────────
  /**
   * @param {object} post 主帖
   * @param {object} themeInput
   * @param {object} images { avatar, media }
   * @param {Array} thread 同作者续帖（可选），会把正文按段落接在一起
   */
  function layout(post, themeInput, images = {}, thread = null) {
    const T = resolveTheme(themeInput);
    const F = T.font;
    const C = T.colors;
    const W = T.width;
    const P = T.padding;
    const innerW = W - P * 2;
    const ops = [];
    let y = P;

    // —— 头部：头像 + 作者名（黑体加粗）+ @handle · 时间 ——
    const avatarY = y;
    ops.push({ kind: 'avatar', x: P, y: avatarY, r: T.avatar / 2, img: images.avatar, initial: post.author.handle });

    // 品牌标记放卡片右上角（不在二维码里）：一眼看出这条来自哪
    ops.push({
      kind: 'brandMark',
      cx: W - P - T.brandMark.size / 2,
      cy: avatarY + T.brandMark.size / 2 + 2,
      size: T.brandMark.size / 2,
      color: T.brandMark.color,
    });

    const textX = P + T.avatar + 15;
    // 给右上角品牌标记留出宽度，避免名字压到它
    const textW = W - P - textX - (T.brandMark.size + 10);

    const nameSpec = F.name;
    const nameBase = avatarY + 4 + nameSpec.size * 0.8;
    ops.push({
      kind: 'text',
      x: textX,
      baseline: nameBase,
      text: post.author.displayName,
      font: nameSpec,
      fill: C.ink,
    });

    const handleSpec = F.handle;
    const handleBase = nameBase + handleSpec.size + 6;
    const handleMeasure = textMeasure(handleSpec);
    const tail = post.dateText ? ' · ' + post.dateText : '';
    const tailW = tail ? handleMeasure(tail) : 0;
    const room = textW - tailW;

    // 显示名和 handle 相同时不重复显示（Threads 上很常见）：
    // 「demo_beta」下面再挂一行「@demo_beta」是纯冗余
    const same = post.author.displayName.replace(/^@/, '').toLowerCase() ===
      post.author.handle.toLowerCase();
    let handle = same ? '' : '@' + post.author.handle;
    if (handle && handleMeasure(handle) > room && room > 40) {
      while (handle.length > 5 && handleMeasure(handle + '…') > room) handle = handle.slice(0, -1);
      handle += '…';
    }
    if (handle) {
      ops.push({ kind: 'text', x: textX, baseline: handleBase, text: handle, font: handleSpec, fill: C.inkSoft });
    }
    if (tail) {
      // 没有 handle 时，时间行去掉前缀的 " · "
      ops.push({
        kind: 'text',
        x: textX + (handle ? handleMeasure(handle) : 0),
        baseline: handleBase,
        text: handle ? tail : tail.replace(/^\s*·\s*/, ''),
        font: handleSpec,
        fill: C.inkSoft,
      });
    }

    y = Math.max(avatarY + T.avatar, handleBase + 4) + 22;

    // —— 正文：衬线 ——
    const bodySpec = F.body;
    const bodyLs = bodySpec.letterSpacing || 0;
    const bodyLh = bodySpec.size * bodySpec.lineHeight;

    /** 画一段正文，返回新的 y */
    const drawBody = (text) => {
      if (!text) return y;
      const lines = TS.wrapText(textMeasure(bodySpec, bodyLs), text, innerW);
      for (const line of lines) {
        if (line === '') {
          y += bodyLh * 0.45;
          continue;
        }
        ops.push({
          kind: 'text',
          x: P,
          baseline: y + bodyLh * 0.5 + bodySpec.size * 0.33,
          text: line,
          font: bodySpec,
          fill: C.ink,
          letterSpacing: bodyLs,
        });
        y += bodyLh;
      }
      return y;
    };

    drawBody(post.text);

    // —— 续帖：同作者串文 ——
    //
    // 段间用"浅底块 + 左侧连线"来区分，贴近 Threads 原生阅读（1/2、2/2 的接续感）。
    // 纯横线或纯留白都试过：前者像分割线（语义变成两篇），后者像同一段换行。
    const rest = Array.isArray(thread) ? thread.slice(1) : [];
    for (const seg of rest) {
      if (!seg.text) continue;
      y += bodyLh * 0.55;

      // 先算这段要占多高，好画底色
      const segLines = TS.wrapText(textMeasure(bodySpec, bodyLs), seg.text, innerW - 20);
      let segH = segLines.reduce((acc, line) => acc + (line === '' ? bodyLh * 0.45 : bodyLh), 0);
      const padV = 12;
      const padH = 14;

      ops.push({
        kind: 'threadBlock',
        x: P,
        y,
        w: innerW,
        h: segH + padV * 2,
        radius: 12,
        fill: C.threadBg,
        barColor: C.accent,
        barWidth: 3,
      });
      y += padV;

      // 段内正文用窄一点的宽度，给底色留内边距
      const innerSegmentW = innerW - padH * 2;
      const segLineHeight = bodyLh;
      for (const line of segLines) {
        if (line === '') {
          y += segLineHeight * 0.45;
          continue;
        }
        ops.push({
          kind: 'text',
          x: P + padH,
          baseline: y + segLineHeight * 0.5 + bodySpec.size * 0.33,
          text: line,
          font: bodySpec,
          fill: C.ink,
          letterSpacing: bodyLs,
        });
        y += segLineHeight;
      }
      void segH;
      void innerSegmentW;
      y += padV;
    }

    // —— 媒体 ——
    //
    // 媒体来源是「整串」（主帖 + 续帖），不是只有主帖：
    // 很多人把图贴在 2/2 里。默认取 post.media；
    // 调用方可用 images.mediaList 传入跨段合并后的完整列表。
    // 最多画 4 张，多出的在末格叠 +N。
    //
    // 排版按张数：
    //   1 张 → 整宽单图，保持原比例（超高则封顶）
    //   2 张 → 并排两栏，等高
    //   3 张 → 左大右二
    //   4 张及以上 → 2x2，末格叠 +N
    const media = (images.mediaList && images.mediaList.length)
      ? images.mediaList
      : (post.media || []);
    const mediaTotal = media.length;
    if (mediaTotal) {
      y += 16;
      const plan = planMedia(media, images.media || [], innerW, T);
      for (const cell of plan.cells) {
        ops.push({
          kind: 'image',
          x: P + cell.x,
          y: y + cell.y,
          w: cell.w,
          h: cell.h,
          radius: T.mediaRadius,
          img: cell.img,
        });
        if (cell.badge) {
          ops.push({
            kind: 'badge',
            x: P + cell.x,
            y: y + cell.y,
            w: cell.w,
            h: cell.h,
            radius: T.mediaRadius,
            text: cell.badge,
            font: T.font.badge,
          });
        }
      }
      y += plan.height;

      // 轮播指示点：只在「图没全显示」时有意义。
      // 1 张不用点；4 张已经全部画出，再画点就是纯噪音；
      // 超过 4 张由末格的 +N 表达剩余。
      if (mediaTotal > 1 && mediaTotal < 4 && T.mediaDots) {
        y += 12;
        const dotR = 3.5;
        const gap = 7;
        const totalW = media.length * dotR * 2 + (media.length - 1) * gap;
        let dx = P + (innerW - totalW) / 2;
        for (let i = 0; i < media.length; i++) {
          ops.push({
            kind: 'dot',
            cx: dx + dotR,
            cy: y + dotR,
            r: dotR,
            fill: i === 0 ? T.colors.inkSoft : T.colors.lineStrong,
          });
          dx += dotR * 2 + gap;
        }
        y += dotR * 2;
      }
    }

    y += 24;

    // —— 分隔线 ——
    ops.push({ kind: 'rule', x: P, y, w: innerW, color: C.line });
    y += 1;

    // —— 统计行 ——
    const statY = y + 26;
    const statSpec = F.stat;
    const numSpec = F.statNum;
    const statMeasure = textMeasure(statSpec);
    const numMeasure = textMeasure(numSpec);
    const stats = [];
    const c = post.counts || {};
    if (c.reply) stats.push([TS.formatCount(c.reply), '回复']);
    if (c.repost) stats.push([TS.formatCount(c.repost), '转发']);
    if (c.like) stats.push([TS.formatCount(c.like), '喜欢']);

    let sx = P;
    for (const [num, label] of stats) {
      ops.push({ kind: 'text', x: sx, baseline: statY, text: num, font: numSpec, fill: C.ink });
      sx += numMeasure(num) + 6;
      ops.push({ kind: 'text', x: sx, baseline: statY, text: label, font: statSpec, fill: C.inkSoft });
      sx += statMeasure(label) + 22;
    }

    y = statY + 12;

    // —— 落款：THREADS + 二维码 ——
    //
    // 文字链接在转发出去的图里点不了，所以改成二维码（微信式，中心留空放图标）。
    //
    // 布局：二维码靠右，THREADS 与「扫码查看原帖」放在左侧同一视觉带里，
    // 既不留下大片空白，也不让二维码孤立。
    const qrSize = T.qr.size;          // 二维码净边长（不含下方说明文字）
    const qrLabelGap = 14;             // 二维码与"扫码查看原帖"的间距
    const blockH = qrSize + qrLabelGap + T.font.link.size;
    const qrTop = y + 12;

    // 左侧文字块：THREADS + 一行提示，与二维码垂直居中
    const leftCenterY = qrTop + qrSize / 2;
    const brandBase = leftCenterY - 2;
    const hintBase = leftCenterY + T.font.link.size + 8;

    ops.push({
      kind: 'brand',
      x: P,
      baseline: brandBase,
      label: 'THREADS',
      font: F.brand,
      fill: C.ink,
      hint: '扫右侧二维码查看原帖',
      hintBaseline: hintBase,
      hintFont: F.link,
      hintFill: C.inkFaint,
      qr: {
        x: P + innerW - qrSize,
        y: qrTop,
        size: qrSize,
        url: post.permalink || '',
      },
      // 把主题里的二维码配置透传给绘制层（留空比例、中心内容等）
      qrOpt: {
        quiet: T.qr.quiet,
        holeRatio: T.qr.holeRatio,
        holeRadius: T.qr.holeRadius,
        fgColor: T.qr.fgColor,
        bgColor: T.qr.bgColor,
        center: T.qr.center,
        centerFill: T.qr.centerFill,
        centerImage: T.qr.centerImage || null,
      },
      innerRight: P + innerW,
    });

    y = qrTop + blockH + P;

    const cardH = Math.ceil(y);
    const fr = T.frame;
    const outerW = fr.enabled ? W + fr.padding * 2 : W;
    const outerH = fr.enabled ? cardH + fr.padding * 2 : cardH;

    return {
      width: outerW,
      height: outerH,
      card: { x: fr.enabled ? fr.padding : 0, y: fr.enabled ? fr.padding : 0, w: W, h: cardH },
      ops,
      theme: T,
    };
  }

  // ── 媒体排布 ────────────────────────────────────────────────────────────
  /**
   * 按图片数量算出网格（相对卡片内容的坐标）。
   *
   * 关键约束：所有格子必须同高，否则视觉上会散；比例靠 cover 裁切吸收。
   * @returns {{cells: Array<{x,y,w,h,img,badge?}>, height: number}}
   */
  function planMedia(media, imgs, width, T) {
    const n = media.length;
    const gap = T.mediaGap;
    const radius = T.mediaRadius;
    const maxH = Math.round(T.width * 1.05);

    const ratioOf = (i) => {
      const im = imgs[i];
      const m = media[i] || {};
      const w = (im && im.naturalWidth) || m.w || 0;
      const h = (im && im.naturalHeight) || m.h || 0;
      return w && h ? w / h : 4 / 5; // 拿不到尺寸就按 4:5 竖图
    };

    const cells = [];
    let height = 0;

    if (n === 1) {
      // 单图：保持原比例，整宽或封顶
      const r = ratioOf(0);
      let w = width;
      let h = Math.round(width / r);
      if (h > maxH) {
        h = maxH;
        w = Math.round(maxH * r);
      }
      cells.push({ x: 0, y: 0, w, h, img: imgs[0] || null });
      height = h;
    } else if (n === 2) {
      const w = Math.round((width - gap) / 2);
      const h = Math.min(Math.round(w * 1.15), maxH);
      cells.push({ x: 0, y: 0, w, h, img: imgs[0] || null });
      cells.push({ x: w + gap, y: 0, w: width - w - gap, h, img: imgs[1] || null });
      height = h;
    } else if (n === 3) {
      // 左大（占 2/3 宽），右二上下
      const leftW = Math.round((width - gap) * 0.66);
      const rightW = width - leftW - gap;
      const h = Math.min(Math.round(width * 0.62), maxH);
      const halfH = Math.round((h - gap) / 2);
      cells.push({ x: 0, y: 0, w: leftW, h, img: imgs[0] || null });
      cells.push({ x: leftW + gap, y: 0, w: rightW, h: halfH, img: imgs[1] || null });
      cells.push({ x: leftW + gap, y: halfH + gap, w: rightW, h: h - halfH - gap, img: imgs[2] || null });
      height = h;
    } else {
      // 4 张及以上：2 列网格
      const shown = Math.min(n, 4);
      const cols = 2;
      const rows = Math.ceil(shown / cols);
      const cellW = Math.round((width - gap * (cols - 1)) / cols);
      // 每行取该行"最竖"的比例来定高，保证同行等高；
      // 但封顶到 1.0（正方形），否则整张 9:16 竖图会把网格拉得极长
      const MAX_CELL_RATIO = 1.0;
      const rowH = [];
      for (let r = 0; r < rows; r++) {
        let maxInv = 0;
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= shown) continue;
          maxInv = Math.max(maxInv, 1 / ratioOf(idx));
        }
        const inv = Math.min(maxInv || 1, MAX_CELL_RATIO);
        rowH.push(Math.round(cellW * inv));
      }
      height = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
      void maxH;

      let yOff = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= Math.min(n, 4)) continue;
          const isLast = idx === Math.min(n, 4) - 1 && n > 4;
          // 每行最后一格吃掉剩余宽度，避免 gap 累积误差
          const x = c * (cellW + gap);
          const w = c === cols - 1 || idx === Math.min(n, 4) - 1 ? width - x : cellW;
          cells.push({
            x,
            y: yOff,
            w,
            h: rowH[r],
            img: imgs[idx] || null,
            badge: isLast ? `+${n - 4}` : undefined,
          });
        }
        yOff += rowH[r] + gap;
      }
    }
    void radius;
    return { cells, height };
  }

  // ── 绘制 ────────────────────────────────────────────────────────────────
  function paint(canvas, plan, scale = 2) {
    const { width: W, height: H, ops, theme: T, card } = plan;
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 外框背景
    const fr = T.frame;
    if (fr.enabled) {
      if (fr.backgroundTo) {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, fr.background);
        g.addColorStop(1, fr.backgroundTo);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = fr.background;
      }
      ctx.fillRect(0, 0, W, H);
    }

    // 卡片：阴影 + G2 圆角
    ctx.save();
    if (fr.enabled && fr.shadow) {
      ctx.shadowColor = fr.shadow.color;
      ctx.shadowBlur = fr.shadow.blur;
      ctx.shadowOffsetY = fr.shadow.offsetY;
    }
    TS.squirclePath(ctx, card.x, card.y, card.w, card.h, T.g2.radius, T.g2.curvature);
    ctx.fillStyle = T.colors.card;
    ctx.fill();
    ctx.restore();

    // 内容整体平移到卡片内
    ctx.save();
    ctx.translate(card.x, card.y);

    for (const op of ops) {
      switch (op.kind) {
        case 'avatar':
          drawAvatar(ctx, op, T);
          break;
        case 'text':
          drawText(ctx, op);
          break;
        case 'image':
          drawImage(ctx, op);
          break;
        case 'badge':
          drawBadge(ctx, op);
          break;
        case 'dot':
          ctx.save();
          ctx.beginPath();
          ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
          ctx.fillStyle = op.fill;
          ctx.fill();
          ctx.restore();
          break;
        case 'brandMark':
          // 右上角 Threads 标记
          if (TS.drawThreadsMark) {
            ctx.save();
            ctx.globalAlpha = op.opacity == null ? 1 : op.opacity;
            TS.drawThreadsMark(ctx, op.cx, op.cy, op.size, op.color);
            ctx.restore();
          }
          break;
        case 'rule':
          ctx.fillStyle = op.color;
          ctx.fillRect(op.x, op.y, op.w, 1);
          break;
        case 'softRule':
          // 串文分段：比主分隔线更淡、更短，只暗示"这是接续的另一条"
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = op.color;
          ctx.fillRect(op.x, op.y, op.w * 0.34, 1);
          ctx.restore();
          break;
        case 'threadBlock':
          // 串文续帖：浅底圆角块 + 左侧品牌色细条
          ctx.save();
          TS.squirclePath(ctx, op.x, op.y, op.w, op.h, op.radius, 3.0);
          ctx.fillStyle = op.fill;
          ctx.fill();
          if (op.barColor) {
            TS.squirclePath(ctx, op.x, op.y, op.barWidth ?? 3, op.h, (op.barWidth ?? 3) / 2, 2.4);
            ctx.fillStyle = op.barColor;
            ctx.globalAlpha = 0.55;
            ctx.fill();
          }
          ctx.restore();
          break;
        case 'threadMark':
          ctx.save();
          ctx.fillStyle = op.color;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          const tmR = 1.6;
          const tmH = op.h;
          // 圆头短竖线
          if (ctx.roundRect) {
            ctx.roundRect(op.x, op.y, tmR * 2, tmH, tmR);
            ctx.fill();
          } else {
            ctx.fillRect(op.x, op.y, tmR * 2, tmH);
          }
          ctx.restore();
          break;
        case 'brand':
          drawBrand(ctx, op);
          break;
        default:
          break;
      }
    }
    ctx.restore();

    return { width: canvas.width, height: canvas.height };
  }

  function drawText(ctx, op) {
    ctx.save();
    ctx.font = fontStr(op.font);
    ctx.fillStyle = op.fill;
    if (op.letterSpacing) {
      let x = op.x;
      for (const ch of op.text) {
        ctx.fillText(ch, x, op.baseline);
        x += ctx.measureText(ch).width + op.letterSpacing;
      }
    } else {
      ctx.fillText(op.text, op.x, op.baseline);
    }
    ctx.restore();
  }

  function drawAvatar(ctx, op, T) {
    const cx = op.x + op.r;
    const cy = op.y + op.r;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, op.r, 0, Math.PI * 2);
    ctx.closePath();
    if (op.img) {
      ctx.clip();
      ctx.drawImage(op.img, op.x, op.y, op.r * 2, op.r * 2);
      ctx.restore();
      return;
    }

    // 拿不到头像时的兜底。
    // 不画首字母：一个孤零零的大写字母看起来像 bug，读者会以为那是头像内容。
    // 用稳定色相的柔和渐变圆代替，视觉上"有东西"，又不冒充真实头像。
    const seed = String(op.initial || '?');
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
    const g = ctx.createLinearGradient(op.x, op.y, op.x + op.r * 2, op.y + op.r * 2);
    g.addColorStop(0, `hsl(${hash}, 42%, 72%)`);
    g.addColorStop(1, `hsl(${(hash + 40) % 360}, 46%, 62%)`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  function drawImage(ctx, op) {
    ctx.save();
    TS.squirclePath(ctx, op.x, op.y, op.w, op.h, op.radius, 3.2);
    ctx.clip();
    if (op.img) {
      const iw = op.img.naturalWidth;
      const ih = op.img.naturalHeight;
      const ir = iw / ih;
      const dr = op.w / op.h;
      let sw = iw;
      let sh = ih;
      let sx = 0;
      let sy = 0;
      if (ir > dr) {
        sw = ih * dr;
        sx = (iw - sw) / 2;
      } else {
        sh = iw / dr;
        sy = (ih - sh) / 2;
      }
      ctx.drawImage(op.img, sx, sy, sw, sh, op.x, op.y, op.w, op.h);
    } else {
      ctx.fillStyle = '#E7ECEF';
      ctx.fillRect(op.x, op.y, op.w, op.h);
    }
    ctx.restore();
  }

  function drawBadge(ctx, op) {
    // 末格遮罩 + 剩余张数（+N）
    ctx.save();
    TS.squirclePath(ctx, op.x, op.y, op.w, op.h, op.radius, 3.2);
    ctx.clip();
    ctx.fillStyle = 'rgba(15, 20, 25, 0.58)';
    ctx.fillRect(op.x, op.y, op.w, op.h);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = fontStr(op.font);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(op.text, op.x + op.w / 2, op.y + op.h / 2);
    ctx.restore();
  }

  /**
   * Threads 官方标记轮廓（24×24 视框）。
   * 用官方路径而不是手绘近似，手绘比例很容易走形。
   */
  const THREADS_MARK_PATH =
    'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z';

  /**
   * 画 Threads 标记（官方轮廓）。
   *
   * size 语义统一为「半边长」，即标记占据 2*size × 2*size 的方框。
   * 用官方 24×24 视框路径等比缩放，避免手绘比例失真。
   */
  TS.drawThreadsMark = function (ctx, cx, cy, size, color) {
    const box = size * 2;              // 目标边长
    const scale = box / 24;            // 24 单位视框 → 目标
    ctx.save();
    ctx.translate(cx - box / 2, cy - box / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = color || '#0F1419';
    if (typeof Path2D !== 'undefined') {
      ctx.fill(new Path2D(THREADS_MARK_PATH));
    } else {
      // 极老环境兜底：不画，避免抛错中断整张图
    }
    ctx.restore();
  };

  function drawBrand(ctx, op) {
    ctx.save();
    ctx.font = fontStr(op.font);
    ctx.fillStyle = op.fill;
    let x = op.x;
    for (const ch of op.label) {
      ctx.fillText(ch, x, op.baseline);
      x += ctx.measureText(ch).width + (op.font.letterSpacing || 0);
    }

    // 左侧提示文字
    if (op.hint) {
      ctx.font = fontStr(op.hintFont);
      ctx.fillStyle = op.hintFill;
      ctx.fillText(op.hint, op.x, op.hintBaseline);
    }

    // 二维码
    if (op.qr && op.qr.url) {
      const { x: qx, y: qy, size, url } = op.qr;
      const qrOpt = op.qrOpt || {};
      const holeRatio = qrOpt.holeRatio || 0;

      const ok = TS.drawQr
        ? TS.drawQr(ctx, url, qx, qy, size, {
            quiet: qrOpt.quiet == null ? 2 : qrOpt.quiet,
            fgColor: qrOpt.fgColor || '#0F1419',
            bgColor: qrOpt.bgColor || '#FFFFFF',
            holeRatio,
            holeRadius: qrOpt.holeRadius || 0,
          })
        : false;

      if (ok) {
        // 中心内容：微信式留空处放识别标记（或任意图）
        if (holeRatio > 0) {
          const cx = qx + size / 2;
          const cy = qy + size / 2;
          const hole = size * holeRatio;
          const fill = qrOpt.centerFill || 0.72;
          const markSize = (hole * fill) / 2;

          if (qrOpt.centerImage) {
            // 传了图片就贴图（圆角裁切）
            ctx.save();
            TS.squirclePath(ctx, cx - markSize, cy - markSize, markSize * 2, markSize * 2, markSize * 0.35, 3);
            ctx.clip();
            ctx.drawImage(qrOpt.centerImage, cx - markSize, cy - markSize, markSize * 2, markSize * 2);
            ctx.restore();
          } else if (qrOpt.center === 'threads' && TS.drawThreadsMark) {
            TS.drawThreadsMark(ctx, cx, cy, markSize, qrOpt.centerColor || '#0F1419');
          }
        }
      }
    }
    ctx.restore();
  }

  /** 生成画布：布局 + 绘制一步到位 */
  TS.renderPost = function (post, theme, images, scale = 2, thread = null) {
    const plan = layout(post, theme, images, thread);
    const canvas = document.createElement('canvas');
    paint(canvas, plan, scale);
    return { canvas, plan };
  };
  TS.Renderer = { layout, paint, resolveTheme, fontStr };
})();
