/* Threshare · QR 码生成（极简实现，无依赖）
 *
 * 把 URL 编成 QR 矩阵。支持字节模式、纠错等级 H、版本 1-15。
 * 参考 ISO/IEC 18004。
 *
 * 为什么用 H 级（30% 容错）而不是 M：
 *   卡片布局要在码中心留一块空白放图标/图片（微信式）。
 *   留空会挖掉模块，只能靠纠错码补回。实测（tests/verify-qr-hole.js）：
 *     · M 级中心留空 28% 还能解，30% 直接全崩（陡崖）
 *     · H 级留空可以更大、更稳，容错余量充足
 *   所以选 H。代价是同样长度需要更高版本（模块更多、更密），
 *   但卡片里二维码边长固定，密一点仍可扫。
 *
 * 为什么要自己实现：扩展不允许远程加载脚本（MV3 CSP），
 * 引第三方库又要走打包流程，而卡片只需要一个静态二维码。
 */
(() => {
  const TS = (globalThis.TS = globalThis.TS || {});

  // 纠错等级 H 的每块参数（版本 1-15）
  // 表：version -> [总码字, 数据码字, 纠错码字/块, 块数]
  const EC_TABLE = {
    1: [26, 9, 17, 1],
    2: [44, 16, 28, 1],
    3: [70, 26, 22, 2],
    4: [100, 36, 16, 4],
    5: [134, 46, 22, 4],
    6: [172, 60, 28, 4],
    7: [196, 66, 26, 5],
    8: [242, 86, 26, 6],
    9: [292, 100, 24, 8],
    10: [346, 122, 28, 8],
    11: [404, 140, 24, 11],
    12: [466, 158, 28, 11],
    13: [532, 180, 22, 16],
    14: [581, 197, 24, 16],
    15: [655, 223, 24, 18],
  };

  // 纠错等级 H 的格式信息编码位
  const EC_BITS_H = 2;

  // 对齐图案中心坐标
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70],
  };

  /** UTF-8 编码 */
  function utf8Bytes(str) {
    const out = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return out;
  }

  /** 选最小可用版本 */
  function pickVersion(len) {
    for (let v = 1; v <= 15; v++) {
      const [, dataWords] = EC_TABLE[v];
      // 字节模式：4 bit 模式 + 8/16 bit 长度 + 数据 + 4 bit 终止
      const lenBits = v < 10 ? 8 : 16;
      const needBits = 4 + lenBits + len * 8;
      if (needBits <= dataWords * 8) return v;
    }
    return null;
  }

  // ── GF(256) 与 Reed-Solomon ──
  const EXP = new Array(512);
  const LOG = new Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsEncode(data, ecLen) {
    // 生成多项式
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], EXP[i]);
      }
      gen = next;
    }
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
    return res;
  }

  /** 生成 QR 矩阵（true = 深色模块） */
  TS.qrMatrix = function (text) {
    const bytes = utf8Bytes(String(text));
    const version = pickVersion(bytes.length);
    if (!version) return null;

    const [totalWords, dataWords, ecLen, blocks] = EC_TABLE[version];
    const size = 17 + version * 4;

    // ── 比特流 ──
    const bits = [];
    const push = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(4, 4); // 字节模式
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    // 终止符
    const cap = dataWords * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    // 填充字节
    const padBytes = [0xec, 0x11];
    let pi = 0;
    while (bits.length < cap) {
      push(padBytes[pi % 2], 8);
      pi++;
    }
    // 转字节
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataCodewords.push(v);
    }

    // ── 分块 + 纠错 + 交织 ──
    const dataPerBlock = Math.floor(dataWords / blocks);
    const remainder = dataWords % blocks;
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < blocks; i++) {
      const len = dataPerBlock + (i >= blocks - remainder ? 1 : 0);
      const blk = dataCodewords.slice(offset, offset + len);
      offset += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }
    const finalBytes = [];
    const maxLen = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) {
      for (const b of dataBlocks) if (i < b.length) finalBytes.push(b[i]);
    }
    for (let i = 0; i < ecLen; i++) {
      for (const b of ecBlocks) if (i < b.length) finalBytes.push(b[i]);
    }

    // ── 矩阵 ──
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false)); // 功能图案标记

    const setFn = (r, c, v) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v;
      fn[r][c] = true;
    };

    // 定位图案
    const finder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const on =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          setFn(r, c, on);
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // 对齐图案
    const centers = ALIGN[version];
    for (const cr of centers) {
      for (const cc of centers) {
        // 跳过与定位图案重叠的位置
        if ((cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 9) || (cr >= size - 9 && cc <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFn(cr + dr, cc + dc, on);
          }
        }
      }
    }

    // 时序图案
    for (let i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }

    // 版本信息（v ≥ 7 必须画，否则解码器读不到版本，整码报废）
    //
    // 18 个模块分两处：左下 6×3 与右上 3×6，内容为「版本号(6bit) + BCH(12bit)」，
    // 生成多项式 0x1F25。省略它会让 v7+ 完全无法解码（踩过）。
    if (version >= 7) {
      let vInfo = version << 12;
      for (let i = 17; i >= 12; i--) {
        if ((vInfo >> i) & 1) vInfo ^= 0x1f25 << (i - 12);
      }
      const vBits = (version << 12) | vInfo;
      // 位置（对照参考实现逐位核对过）：
      //   row = floor(i / 3), col = i % 3 + size - 11
      //   两个副本互为转置
      for (let i = 0; i < 18; i++) {
        const mod = ((vBits >> i) & 1) === 1;
        const row = Math.floor(i / 3);
        const col = (i % 3) + size - 11;
        setFn(row, col, mod);
        setFn(col, row, mod);
      }
    }

    // ── 格式信息占位 ──
    //
    // 15 位格式信息分两处各一份（冗余），共 31 个位置：
    //   副本 A：第 8 行（列 0-8，跳过列 6） + 第 8 列（行 0-8，跳过行 6）
    //   副本 B：第 8 行右侧 8 位 + 第 8 列底部 7 位
    // 外加固定深色模块 (size-8, 8)。
    //
    // 这些位置必须先标成功能图案，否则数据会被写进去（踩过：v7+ 整码报废）。
    const formatPositions = [];
    for (let i = 0; i <= 5; i++) formatPositions.push([8, i]);
    formatPositions.push([8, 7]);
    formatPositions.push([8, 8]);
    formatPositions.push([7, 8]);
    for (let i = 9; i <= 14; i++) formatPositions.push([14 - i, 8]);
    // 副本 B
    for (let i = 0; i <= 7; i++) formatPositions.push([8, size - 1 - i]);
    for (let i = 8; i <= 14; i++) formatPositions.push([size - 15 + i, 8]);
    for (const [r, c] of formatPositions) setFn(r, c, false);
    // 固定深色模块
    setFn(size - 8, 8, true);

    // ── 放置数据 ──
    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // 跳过时序列
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (fn[row][c]) continue;
          let bit = 0;
          if (bitIdx < finalBytes.length * 8) {
            bit = (finalBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          }
          m[row][c] = bit === 1;
          bitIdx++;
        }
      }
      upward = !upward;
    }

    // ── 掩码选择（固定用 mask 0，够用且稳定） ──
    const maskFn = (r, c) => (r + c) % 2 === 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fn[r][c] && maskFn(r, c)) m[r][c] = !m[r][c];
      }
    }

    // ── 格式信息 ──
    //
    // 15 位串按 **MSB-first** 顺序写入（用参考实现反推验证过）：
    //   seq[k] = (fmtFinal >> (14 - k)) & 1
    // 之前按 LSB 写，导致 v7+ 与更高位的版本信息叠加后整码报废（踩过）。
    const ecBits = EC_BITS_H; // H 级（30% 容错），留出中心空白
    const maskBits = 0; // mask 0
    const fmt = (ecBits << 3) | maskBits;
    let fmtVal = fmt << 10;
    const gPoly = 0x537;
    for (let i = 14; i >= 10; i--) {
      if ((fmtVal >> i) & 1) fmtVal ^= gPoly << (i - 10);
    }
    const fmtFinal = ((fmt << 10) | fmtVal) ^ 0x5412;

    // 第 k 位（MSB 起算）
    const fmtBit = (k) => ((fmtFinal >> (14 - k)) & 1) === 1;

    // 副本 A（沿第 8 行向列增长，再沿第 8 列向行增长，跳过时序位）
    let k = 0;
    for (let c = 0; c <= 5; c++) setFn(8, c, fmtBit(k++));
    setFn(8, 7, fmtBit(k++));
    setFn(8, 8, fmtBit(k++));
    setFn(7, 8, fmtBit(k++));
    for (let r = 5; r >= 0; r--) setFn(r, 8, fmtBit(k++));

    // 副本 B（右上 8 位 + 左下 7 位）
    k = 0;
    for (let c = size - 1; c >= size - 8; c--) setFn(8, c, fmtBit(k++));
    for (let r = size - 7; r <= size - 1; r++) setFn(r, 8, fmtBit(k++));

    return { size, matrix: m };
  };

  /**
   * 把 QR 画到 canvas ctx 的指定矩形里。
   *
   * opts:
   *   quiet       静区模块数（默认 2）
   *   fgColor/bgColor
   *   holeRatio   中心留空边长占整幅的比例（0 = 不留空）。
   *               微信式设计：留空处可放任意图标/图片。
   *               H 级纠错下实测安全值见 tests/verify-qr-hole.js。
   *   holeRadius  留空区域圆角（占比，0 = 方形）
   */
  TS.drawQr = function (ctx, text, x, y, sizePx, opts = {}) {
    const qr = TS.qrMatrix(text);
    if (!qr) return false;
    const { size, matrix } = qr;
    const quiet = opts.quiet == null ? 2 : opts.quiet; // 静区（模块数）
    const total = size + quiet * 2;
    const cell = sizePx / total;
    const holeRatio = opts.holeRatio || 0;

    ctx.save();
    // 白底（保证扫描对比度）
    if (opts.background !== false) {
      ctx.fillStyle = opts.bgColor || '#FFFFFF';
      ctx.fillRect(x, y, sizePx, sizePx);
    }
    ctx.fillStyle = opts.fgColor || '#0F1419';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!matrix[r][c]) continue;
        const px = x + (c + quiet) * cell;
        const py = y + (r + quiet) * cell;
        // 向上取整，避免模块间出现白缝
        ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(cell), Math.ceil(cell));
      }
    }

    // 中心留空：直接挖成纯白（露出的就是底色），供调用方放图标
    if (holeRatio > 0) {
      const hole = sizePx * holeRatio;
      const hx = x + (sizePx - hole) / 2;
      const hy = y + (sizePx - hole) / 2;
      ctx.fillStyle = opts.bgColor || '#FFFFFF';
      if (opts.holeRadius) {
        const rr = hole * opts.holeRadius;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(hx, hy, hole, hole, rr);
          ctx.fill();
        } else {
          ctx.fillRect(hx, hy, hole, hole);
        }
      } else {
        ctx.fillRect(hx, hy, hole, hole);
      }
    }

    ctx.restore();
    return true;
  };
})();
