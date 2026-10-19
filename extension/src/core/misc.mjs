// ---------- 通用小工具：DOM 构建 / 文本转义 / 节流防抖 / 视口 ----------
// 全仓 UI 只用 el() 建元素、clearChildren() 清空子节点（不出现 innerHTML，见 README「硬不变式」）。
// 依赖：无（最底层模块，core/ 其余模块与各 UI 入口都可以引它）。
export function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** 清空子节点：插件 UI 重建用（替代 innerHTML = ''，全文不出现任何 innerHTML） */
export function clearChildren(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}
export function debounce(fn, ms) {
  let t = null;
  return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
}
export function throttle(fn, ms) {
  let last = 0, pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { last = Date.now(); pending = null; fn(...args); }, ms - (now - last));
  };
}
export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) { if (c != null) e.append(c); }
  return e;
}
export function visibleViewport(win) {
  const vw = Math.max(win.document.documentElement.clientWidth, win.innerWidth || 0);
  const vh = Math.max(win.document.documentElement.clientHeight, win.innerHeight || 0);
  return { x: win.scrollX || 0, y: win.scrollY || 0, w: vw, h: vh };
}
