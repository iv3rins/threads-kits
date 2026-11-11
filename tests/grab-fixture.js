/* 浏览器端抓取夹具
 * 线上页面 CSP 会拦截到 localhost 的 fetch，所以改走「复制到剪贴板」这条路：
 * 在 Threads 页面控制台里粘贴本函数体即可。
 *
 * 用法：打开目标帖子页 → F12 控制台 → 粘贴下方整段 → 回车，
 *      然后把剪贴板内容存成 tests/dumps/post-page-1.html
 */
(async () => {
  const pagelet = document.querySelector('[data-pagelet="threads_post_page_1"]')
    || document.querySelector('[data-pressable-container]').parentElement;
  const html = pagelet.outerHTML;
  try {
    await navigator.clipboard.writeText(html);
    console.log('已复制 %d 字节到剪贴板 → 存成 tests/dumps/post-page-1.html', html.length);
  } catch (e) {
    console.log('剪贴板不可用，请手动复制下面的字符串：\n' + html);
  }
  return html.length;
})();
