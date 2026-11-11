/* Threshare · 内容脚本
 * 职责：
 *   1) 在每条帖子的操作栏尾部挂一个「分享卡片」按钮
 *   2) 点击后提取帖子数据 → 渲染卡片 → 弹出预览
 *   3) 预览里可复制图片 / 下载 PNG
 *
 * 思路：所有样式走 Shadow DOM，绝不污染 Threads 自身样式；
 * 只用 MutationObserver 增量扫描，不轮询整页。
 */
(() => {
  const TS = (globalThis.TS = globalThis.TS || {});
  if (TS.__contentLoaded) return;
  TS.__contentLoaded = true;

  const BTN_CLASS = 'threshare-btn';
  const HOST_ID = 'threshare-overlay-host';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // X 风格的分享图标
  const ICON_SHARE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/></svg>`;

  // ── 按钮挂载 ────────────────────────────────────────────────────────────
  /** 找帖子里的原生「分享」按钮：先按操作栏定位，栏找不到再退化为全局找 */
  function findNativeShare(container) {
    const svgOf = (root) =>
      [...root.querySelectorAll('svg')].find((s) => {
        const t = s.querySelector('title');
        return t && /分享|share/i.test(t.textContent || '');
      });
    const row = TS.actionRow ? TS.actionRow(container) : null;
    const svg = (row && svgOf(row)) || svgOf(container);
    return svg ? svg.closest('[role="button"]') : null;
  }

  function ensureButton(container) {
    // 已挂且还在原位就跳过；被 React 重渲染冲掉时这里会重新挂
    if (container.querySelector('.' + BTN_CLASS)) return;

    const anchorWrap = findNativeShare(container);
    if (!anchorWrap || !anchorWrap.parentElement) return;

    const btn = document.createElement('div');
    btn.className = BTN_CLASS;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', '用 Threshare 分享为图片');
    btn.title = 'Threshare · 分享为图片';
    btn.innerHTML = ICON_SHARE;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreview(container, btn);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPreview(container, btn);
      }
    });

    anchorWrap.parentElement.insertBefore(btn, anchorWrap.nextSibling);
    container.dataset.threshareDone = '1';
  }

  /** 只扫给定子树，避免长列表里每次变更都全页重扫 */
  function scan(root = document) {
    const targets = new Set();
    if (root.matches && root.matches('[data-pressable-container]')) targets.add(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[data-pressable-container]').forEach((el) => targets.add(el));
      root.closest && root.closest('[data-pressable-container]') &&
        targets.add(root.closest('[data-pressable-container]'));
    }
    for (const c of targets) {
      if (!c.querySelector('time') || !c.querySelector('a[href^="/@"]')) continue;
      try {
        ensureButton(c);
      } catch (err) {
        console.warn('[Threshare] mount failed', err);
      }
    }
  }

  // ── 预览弹层 ────────────────────────────────────────────────────────────
  async function openPreview(container, btnEl) {
    // 取主帖；若是同作者串文（1/2、2/2），把续帖一并取来合成一张卡
    const thread = TS.extractThread ? TS.extractThread(container) : [];
    const post = thread[0] || TS.extractPost(container);
    if (!post) {
      toast('这条帖子没有可分享的内容');
      return;
    }
    btnEl.classList.add('is-loading');

    const ov = getOverlay();
    ov.showLoading();

    try {
      // 媒体要跨串文各段一起收：很多人是把图贴在续帖里的，
      // 只取主帖会漏掉。上限由渲染层控制（最多 4 张，多出的叠 +N）。
      const mediaList = TS.collectThreadMedia ? TS.collectThreadMedia(thread) : (post.media || []);
      const [avatar, media] = await Promise.all([
        TS.resolveImage(post.author.avatarSrc, post.author.avatarEl),
        TS.loadImages
          ? TS.loadImages(mediaList.map((m) => m.src), 4, mediaList.map((m) => m.el))
          : Promise.all(mediaList.map((m) => TS.resolveImage(m.src, m.el))),
      ]);
      const { canvas, plan } = TS.renderPost(
        post,
        null,
        { avatar, media, mediaList },
        2,
        thread
      );
      ov.showResult(canvas, post, plan, thread.length);
    } catch (err) {
      console.error('[Threshare] render failed', err);
      ov.showError(err);
    } finally {
      btnEl.classList.remove('is-loading');
    }
  }

  function toast(msg) {
    const ov = getOverlay();
    ov.showToast(msg);
  }

  // ── 弹层实现（Shadow DOM，样式完全隔离） ────────────────────────────────
  function getOverlay() {
    let host = document.getElementById(HOST_ID);
    if (host && host.__ts) return host.__ts;

    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="scrim"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Threshare 分享预览">
        <div class="head">
          <div class="title">分享预览<span class="ver">v${TS.VERSION}</span></div>
          <button class="close" aria-label="关闭">✕</button>
        </div>
        <div class="stage"><div class="loading">正在生成…</div></div>
        <div class="foot">
          <div class="hint">可见效果与导出一致</div>
          <div class="actions">
            <button class="btn ghost" data-act="copy">复制图片</button>
            <button class="btn primary" data-act="download">下载 PNG</button>
          </div>
        </div>
        <div class="toast"></div>
      </div>`;
    shadow.appendChild(wrap);

    const stage = wrap.querySelector('.stage');
    const toastEl = wrap.querySelector('.toast');
    let currentCanvas = null;

    function close() {
      host.style.display = 'none';
      document.documentElement.style.overflow = '';
    }
    wrap.querySelector('.close').addEventListener('click', close);
    wrap.querySelector('.scrim').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host.style.display !== 'none') close();
    });

    wrap.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      if (!currentCanvas) return;
      try {
        const blob = await new Promise((res) => currentCanvas.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToastEl(toastEl, '已复制到剪贴板');
      } catch (err) {
        console.error(err);
        showToastEl(toastEl, '复制失败，请用「下载 PNG」');
      }
    });

    wrap.querySelector('[data-act="download"]').addEventListener('click', () => {
      if (!currentCanvas) return;
      currentCanvas.toBlob((blob) => {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = `threshare-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToastEl(toastEl, '已开始下载');
      }, 'image/png');
    });

    const api = {
      showLoading() {
        host.style.display = 'block';
        document.documentElement.style.overflow = 'hidden';
        stage.innerHTML = '<div class="loading">正在生成…</div>';
        currentCanvas = null;
      },
      showResult(canvas, post, plan, threadLen) {
        stage.innerHTML = '';
        canvas.className = 'canvas';
        stage.appendChild(canvas);
        currentCanvas = canvas;

        // 展示尺寸。
        // 窄窗（420 小窗）下不能同时限死宽高：一张 2500px 高的串文卡若按
        // maxHeight 缩，会变成邮票大小。这里改为「限宽不限高，纵向滚动」。
        const narrow = window.innerWidth <= 560;
        canvas.style.maxWidth = '100%';
        if (narrow) {
          canvas.style.maxHeight = 'none';
        } else {
          canvas.style.maxHeight = '60vh';
        }
        // 窄窗里预览区给足高度，让长卡能滚
        stage.style.maxHeight = narrow ? 'calc(100vh - 150px)' : '';

        // 底部提示带上实际规格，方便判断导出是否符合预期
        const parts = [];
        if (threadLen > 1) parts.push(`串文 ${threadLen} 段已合并`);
        if (post && post.media && post.media.length > 1) parts.push(`${post.media.length} 张媒体`);
        if (plan) parts.push(`导出 ${canvas.width}×${canvas.height}`);
        const hintEl = wrap.querySelector('.hint');
        if (hintEl) hintEl.textContent = parts.length ? parts.join(' · ') : '可见效果与导出一致';
      },
      showError(err) {
        stage.innerHTML = `<div class="loading">生成失败：${String(err && err.message || err).slice(0, 120)}</div>`;
      },
      showToast(msg) {
        showToastEl(toastEl, msg);
      },
    };
    host.__ts = api;
    document.documentElement.appendChild(host);
    return api;
  }

  function showToastEl(el, msg) {
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el.__t);
    el.__t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483000; display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.62); backdrop-filter: blur(6px); }
    .dialog { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
      width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 32px);
      background: #16181C; color: #E7E9EA; border-radius: 24px; overflow: hidden;
      display: flex; flex-direction: column;
      box-shadow: 0 24px 80px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.08); }
    .head { display:flex; align-items:center; justify-content:space-between;
      padding: 16px 18px 12px; }
    .title { font-size: 15px; font-weight: 700; letter-spacing: .3px; color:#E7E9EA;
      display:flex; align-items:center; gap:8px; }
    .ver { font-size: 11px; font-weight: 600; color:#71767B;
      background: rgba(255,255,255,.08); padding: 2px 7px; border-radius: 999px;
      letter-spacing: 0; }
    .close { background: transparent; border: 0; color: #8B98A5; font-size: 16px;
      cursor: pointer; line-height: 1; padding: 6px; border-radius: 999px; }
    .close:hover { background: rgba(255,255,255,.08); color:#E7E9EA; }
    .stage { padding: 4px 18px 14px; overflow: auto; display:flex; justify-content:center;
      align-items:flex-start; }
    .canvas { display:block; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.4);
      /* 窄窗下卡片会比可视区高很多，用 wheel 滚动查看 */
      max-width: 100%; }
    .loading { padding: 48px 0; color:#8B98A5; font-size: 14px; text-align:center; }
    .foot { display:flex; align-items:center; justify-content:space-between; gap:12px;
      padding: 14px 18px 16px; border-top: 1px solid rgba(255,255,255,.08); flex-wrap: wrap; }
    .hint { font-size: 12px; color:#71767B; }
    .actions { display:flex; gap:10px; }
    .btn { border:0; border-radius: 999px; padding: 9px 16px; font-size: 14px;
      font-weight: 700; cursor: pointer; font-family: inherit; white-space: nowrap; }
    .btn.ghost { background: rgba(255,255,255,.1); color:#E7E9EA; }
    .btn.ghost:hover { background: rgba(255,255,255,.16); }
    .btn.primary { background:#E7E9EA; color:#0F1419; }
    .btn.primary:hover { background:#fff; }
    .toast { position:absolute; left:50%; bottom: 76px; transform: translate(-50%, 8px);
      background: #1D9BF0; color:#fff; font-size: 13px; font-weight: 600;
      padding: 8px 14px; border-radius: 999px; opacity: 0; pointer-events:none;
      transition: opacity .18s, transform .18s; max-width: calc(100% - 40px); text-align:center; }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }

    /* 窄窗（小窗模式 420 宽）专用收紧 */
    @media (max-width: 520px) {
      .dialog { width: calc(100vw - 12px); max-height: calc(100vh - 16px);
        border-radius: 18px; }
      .head { padding: 12px 14px 8px; }
      .stage { padding: 2px 12px 10px; }
      .foot { padding: 10px 12px 12px; gap: 8px; }
      .hint { font-size: 11px; }
      .btn { padding: 8px 13px; font-size: 13px; }
      .toast { bottom: 68px; font-size: 12px; }
    }
  `;

  // 按钮样式注入到页面（按钮在 Threads 的 DOM 里，无法用 shadow）
  function injectButtonCSS() {
    if (document.getElementById('threshare-btn-style')) return;
    const s = document.createElement('style');
    s.id = 'threshare-btn-style';
    s.textContent = `
      .${BTN_CLASS} {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; border-radius: 999px;
        color: var(--barcelona-charcoal-icon, #A0A0A0);
        cursor: pointer; transition: background .15s, color .15s;
      }
      .${BTN_CLASS}:hover { background: rgba(29,155,240,.14); color: #1D9BF0; }
      .${BTN_CLASS}.is-loading { opacity: .5; pointer-events: none; }
      .${BTN_CLASS} svg { display:block; }
    `;
    document.documentElement.appendChild(s);
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  function boot() {
    injectButtonCSS();
    scan(document);

    // 只处理新增节点，不做全页重扫：Threads 是长列表，全页扫描成本随滚动线性上涨
    const pending = new Set();
    let scheduled = false;
    const flushScan = () => {
      scheduled = false;
      const roots = [...pending];
      pending.clear();
      for (const r of roots) {
        if (!r.isConnected) continue;
        try {
          scan(r);
        } catch (err) {
          console.warn('[Threshare] scan failed', err);
        }
      }
    };

    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          // 新增节点本身或其内部含帖子容器才值得排队
          if (
            (n.matches && n.matches('[data-pressable-container]')) ||
            (n.querySelector && n.querySelector('[data-pressable-container]'))
          ) {
            pending.add(n);
          }
        }
      }
      if (pending.size && !scheduled) {
        scheduled = true;
        setTimeout(flushScan, 150);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // ── 补偿扫描 ──
    //
    // 只靠 MutationObserver 不够：Threads 是虚拟列表，滚动时会复用已有节点
    // （只改文本、不新增元素），此时按钮可能被 React 重渲染冲掉却触发不了回调。
    // 这里低频（1.2s）检查视口内的容器，只在「缺按钮」时才动手，成本很低。
    let sweeping = false;
    const sweepVisible = () => {
      if (sweeping) return;
      sweeping = true;
      try {
        const vh = window.innerHeight || 800;
        const conts = document.querySelectorAll('[data-pressable-container]');
        for (const c of conts) {
          if (c.querySelector('.' + BTN_CLASS)) continue;
          const r = c.getBoundingClientRect();
          // 只看视口附近，避免长列表全量扫描
          if (r.bottom < -300 || r.top > vh + 300) continue;
          if (!c.querySelector('time') || !c.querySelector('a[href^="/@"]')) continue;
          try {
            ensureButton(c);
          } catch (err) {
            /* 单条失败不影响其它 */
          }
        }
      } finally {
        sweeping = false;
      }
    };
    setInterval(sweepVisible, 1200);

    // 滚动时也补一次（虚拟列表复用节点的时机就在滚动）
    let scrollTimer = null;
    window.addEventListener(
      'scroll',
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(sweepVisible, 260);
      },
      { passive: true }
    );

    // Threads 是 SPA，靠 pushState 切页。切换后 body 可能整块换掉，
    // MutationObserver 挂在旧 body 上就失效了 —— 这里做一次兜底重挂。
    let lastHref = location.href;
    const onRouteChange = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      setTimeout(() => {
        if (mo.__target !== document.body) {
          mo.disconnect();
          mo.observe(document.body, { childList: true, subtree: true });
          mo.__target = document.body;
        }
        scan(document);
      }, 400);
    };
    window.addEventListener('popstate', onRouteChange);
    const wrapHistory = (name) => {
      const orig = history[name];
      history[name] = function (...args) {
        const ret = orig.apply(this, args);
        onRouteChange();
        return ret;
      };
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
  }

  TS.mount = function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else boot();
  };
  TS.mount();
})();
