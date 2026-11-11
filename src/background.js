/* 后台 service worker
 *
 * 路线说明（实测结论）：
 *   threads.com 返回 X-Frame-Options: DENY，且即使去掉该头，
 *   它在子 frame 里也拒绝建立会话（页面显示「链接失效」）。
 *   所以「侧边栏 iframe 嵌网页」不可行，改用独立 popup 窗口：
 *   那是真正的顶层页面，登录态、关注流、发帖、回复全部正常。
 *
 * 职责：
 *   1) 点工具栏图标 → 打开/聚焦 420x900 的 popup 窗口（手机版宽度）
 *   2) 记住窗口位置，再次打开时复位
 *   3) 让页面内的内容脚本能请求"开小窗/切页"
 */

const POPUP_KEY = 'ts:popup:windowId';
const WIDTH = 420;   // Threads 移动断点内，自动出手机版布局
const HEIGHT = 900;
const START_URL = 'https://www.threads.com/';

/** 打开或聚焦已存在的小窗 */
async function openPopup(url) {
  const target = url || START_URL;

  // 先看有没有已经开着的小窗，有就直接切页并聚焦，不重复开
  let existingId = null;
  try {
    const store = await chrome.storage.session.get(POPUP_KEY);
    existingId = store && store[POPUP_KEY];
  } catch (e) {
    existingId = null;
  }

  if (existingId != null) {
    try {
      const win = await chrome.windows.get(existingId);
      if (win) {
        const tabs = await chrome.tabs.query({ windowId: existingId });
        if (tabs && tabs[0]) {
          await chrome.tabs.update(tabs[0].id, { url: target });
          await chrome.windows.update(existingId, { focused: true });
          return { reused: true, windowId: existingId };
        }
      }
    } catch (e) {
      // 窗口已被关闭，继续新建
    }
  }

  // 新建：靠屏幕右侧，方便上班时放在角落
  const width = WIDTH;
  const height = HEIGHT;
  let left;
  let top;
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur && typeof cur.width === 'number') {
      left = Math.max(0, Math.round((cur.left || 0) + cur.width - width - 24));
      top = Math.max(0, Math.round((cur.top || 0) + 72));
    }
  } catch (e) {
    /* 拿不到位置就交给浏览器默认 */
  }

  const win = await chrome.windows.create({
    url: target,
    type: 'popup',   // popup 类型没有标签栏与地址栏，最接近手机观感
    width,
    height,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    focused: true,
  });

  try {
    await chrome.storage.session.set({ [POPUP_KEY]: win.id });
  } catch (e) {
    /* session storage 不可用不影响主流程 */
  }
  return { reused: false, windowId: win.id };
}

// 点工具栏图标 → 开小窗（不依赖 sidePanel，兼容所有版本）
chrome.action.onClicked.addListener(() => {
  openPopup().catch((e) => console.warn('[Threshare] open popup failed', e));
});

// 窗口关闭时清掉记录，避免下次误判
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const store = await chrome.storage.session.get(POPUP_KEY);
    if (store && store[POPUP_KEY] === windowId) {
      await chrome.storage.session.remove(POPUP_KEY);
    }
  } catch (e) {
    /* ignore */
  }
});

// 页面内的内容脚本可以请求开小窗 / 切到指定帖子
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ts:openPopup') {
    openPopup(msg.url).then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message) }));
    return true;
  }
  if (msg.type === 'ts:getActiveThreadsUrl') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      sendResponse({ url: t && t.url && /threads\.(com|net)/.test(t.url) ? t.url : null });
    });
    return true;
  }
});

// 安装时给个提示，说明怎么用
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.windows.create({
      url: START_URL,
      type: 'popup',
      width: WIDTH,
      height: HEIGHT,
      focused: true,
    }).then((win) => chrome.storage.session.set({ [POPUP_KEY]: win.id })).catch(() => {});
  }
});
