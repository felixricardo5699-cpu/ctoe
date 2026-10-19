// ---------- DOM 提取层：TreeWalker 只收集 TextNode ----------
// 一条通用路径：document.createTreeWalker(root, SHOW_TEXT/SHOW_ELEMENT) +
// 规则层剪枝。没有站点判断，没有整页文本聚合。
//
// 关键点：
//   * 元素命中「标签/区域」规则时返回 FILTER_REJECT —— TreeWalker 直接剪掉整棵子树，
//     所以 nav/footer/aside/广告/脚本/代码块既不会产出文本，也不会被遍历到（省时间）；
//   * shadow DOM：TreeWalker 不跨 shadow 边界，这里在遍历元素的同一趟里顺手收集
//     open shadow root，再用它当 root 继续走（递归、支持嵌套组件）；
//   * 只产出 TextNode，绝不产出「容器 + 区间」这种复合单元 —— 单元粒度就是文本节点，
//     这是「帖子边界丢失 / 多个标题被拼进同一个节点」的根治手段。
import { isSkippableElement, isTranslatableText, isVisible, ownerElementOf } from './rules.mjs';

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_SKIP = 3;
const FILTER_REJECT = 2;

/**
 * 收集一棵子树（含其内部所有 open shadow root）里「值得翻译的 TextNode」。
 * @param {Node} root Element / Document / ShadowRoot / Text
 * @param {object} rules buildRules() 的产物
 * @param {{stats?:object, isSkippedText?:(n:Text)=>boolean, onShadowRoot?:(sr:ShadowRoot)=>void}} opts
 * @returns {Text[]} 文档顺序的文本节点数组
 */
export function collectTextNodes(root, rules, opts = {}) {
  const out = [];
  if (!root) return out;
  const doc = root.ownerDocument || (root.nodeType === 9 ? root : null);
  if (!doc || typeof doc.createTreeWalker !== 'function') return out;
  const stats = opts.stats || null;
  const isSkippedText = typeof opts.isSkippedText === 'function' ? opts.isSkippedText : null;
  const onShadowRoot = typeof opts.onShadowRoot === 'function' ? opts.onShadowRoot : null;
  const shadowRoots = [];

  const wantText = (node) => {
    if (stats) stats.textNodes++;
    if (isSkippedText && isSkippedText(node)) return false;
    if (!isTranslatableText(node.data, rules)) return false;
    const el = ownerElementOf(node);
    if (!el || !el.isConnected) return false;   // 已从文档摘除的节点不译
    if (!isVisible(el, rules)) return false;
    out.push(node);
    return true;
  };

  const accept = (node) => {
    const nt = node.nodeType;
    if (nt === 3) return wantText(node) ? FILTER_ACCEPT : FILTER_SKIP;
    if (nt !== 1) return FILTER_SKIP;
    if (stats) stats.scanned++;
    if (isSkippableElement(node, rules)) return FILTER_REJECT; // 整棵子树剪掉
    if (node.shadowRoot) {
      shadowRoots.push(node.shadowRoot);
      if (onShadowRoot) onShadowRoot(node.shadowRoot);
    }
    return FILTER_ACCEPT;
  };

  const walk = (r) => {
    if (!r) return;
    if (r.nodeType === 3) { wantText(r); return; }
    if (r.nodeType !== 1 && r.nodeType !== 9 && r.nodeType !== 11) return;
    let walker;
    try {
      walker = doc.createTreeWalker(r, SHOW_ELEMENT | SHOW_TEXT, accept);
    } catch (_) { return; }
    try {
      while (walker.nextNode()) { /* 收集发生在 accept 里 */ }
    } catch (_) { /* 页面在遍历中被改动：已收集的部分照常返回 */ }
  };

  walk(root);
  // shadow root 在遍历中被发现（含嵌套），按发现顺序继续走
  for (let i = 0; i < shadowRoots.length; i++) walk(shadowRoots[i]);
  return out;
}

/**
 * 单个文本节点是否允许翻译（含祖先链检查）。
 * 用于 MutationObserver 直接报上来的「游离文本节点」——它们没有经过 TreeWalker 剪枝，
 * 必须自己确认祖先里没有 nav/footer/广告/未显示节点。
 */
export function isAllowedTextNode(node, rules) {
  if (!node || node.nodeType !== 3) return false;
  if (!isTranslatableText(node.data, rules)) return false;
  let cur = ownerElementOf(node);
  if (!cur || !cur.isConnected) return false;
  while (cur) {
    if (cur.nodeType === 1) {
      if (isSkippableElement(cur, rules)) return false;
      if (!isVisible(cur, rules)) return false;
    }
    const p = cur.parentNode;
    cur = p ? (p.nodeType === 11 && p.host ? p.host : p) : null;
  }
  return true;
}
