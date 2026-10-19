// ---------- 合并层：Merge -> Translate -> Split（句级重建） ----------
// 一个句子常被行内标签切成多个 TextNode：
//   "Please read the " + <a>official docs</a> + " and press " + <b>Send feedback</b> + " to continue."
// 逐节点翻译会把一句话拆成互不相干的碎片（语序、语气、代词全都对不上）。这里把
// 「同一个块级容器内、中间只隔着行内内容」的连续文本节点合并成一个翻译单元，
// 请求时用片段分隔符保住片段边界，收到译文后再按分隔符切回各自节点。
//
// 硬保证（缺一不可）：
//   1) 合并范围不跨容器、不跨块级元素 / <br> / <hr>：两个帖子、两个商品标题、两个段落
//      永远落在不同单元 —— 这是「跨帖合并 / 标题挤在一起」的根治手段；
//   2) 拆回来必须「片段数完全相等且没有空片段」，否则整组作废、退回逐节点翻译 ——
//      宁可多一次请求，也绝不猜着切、绝不错位；
//   3) 拆分失败的节点会被标记为 solo，之后永不参与合并，不会出现
//      「合并 -> 失败 -> 再合并」的死循环。
//
// 节点身份完全不变：合并只决定「请求里发什么」，回写仍然是一个 TextNode 一个片段。
import { isInlineBox, isSkippableElement, nearestBlockContainer } from './rules.mjs';

/** 片段分隔符：控制字符 U+0001，不是空白 —— 引擎的空白归一化与批量行的打包都不会把它当分隔符 */
export const SEG = '\u0001';
export const MERGE_MAX_SEGMENTS = 24;   // 单个单元最多合并多少个文本节点
export const MERGE_MAX_CHARS = 1200;    // 合并后原文长度上限（不能把整篇文章拼成一条）
const BARRIER_SCAN_MAX = 400;           // 屏障扫描的元素上限：超大容器直接放弃合并
const FOLLOWING = 4;                    // Node.DOCUMENT_POSITION_FOLLOWING
const FILTER_ACCEPT = 1;
const FILTER_SKIP = 3;
const FILTER_REJECT = 2;
const SHOW_ELEMENT = 0x1;

/** 末尾是否空白字符（等价 /\s$/，这里用字符表避免正则转义） */
const SPACE_TAIL = (() => {
  let s = ' \t\n\r\f\v' + String.fromCharCode(0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff);
  for (let cp = 0x2000; cp <= 0x200a; cp++) s += String.fromCharCode(cp);
  return s;
})();

export function endsWithSpace(s) {
  const t = String(s == null ? '' : s);
  return t.length > 0 && SPACE_TAIL.indexOf(t.charAt(t.length - 1)) >= 0;
}

/** mid 是否严格位于 a 与 b 之间（文档顺序） */
function isBetween(a, b, mid) {
  try {
    if (!a.compareDocumentPosition || !mid.compareDocumentPosition) return false;
    return (a.compareDocumentPosition(mid) & FOLLOWING) !== 0 &&
           (mid.compareDocumentPosition(b) & FOLLOWING) !== 0;
  } catch (_) { return false; }
}

/**
 * 扫描容器内「会切断句子」的屏障元素：块级盒子 + <br> / <hr>。
 * 不译子树（video / select / input / img / svg …）不算屏障 —— 句子从它们两侧继续，
 * 正是「图片夹在句子中间」这类情形该合并的样子。
 * 元素过多时返回 null，表示该容器放弃合并（不冒性能风险）。
 */
function scanBarriers(container, rules) {
  const doc = container.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== 'function') return null;
  const out = [];
  let seen = 0;
  let tooBig = false;
  const accept = (el) => {
    if (el === container) return FILTER_ACCEPT;
    if (++seen > BARRIER_SCAN_MAX) { tooBig = true; return FILTER_REJECT; }
    const tag = el.tagName;
    if (tag === 'BR' || tag === 'HR') { out.push(el); return FILTER_SKIP; }
    let skipped = false;
    try { skipped = isSkippableElement(el, rules); } catch (_) { skipped = false; }
    if (skipped) return FILTER_REJECT;
    if (isInlineBox(el, rules)) return FILTER_ACCEPT;
    out.push(el);
    return FILTER_REJECT;   // 块级子树整体就是一个屏障，不必再往下看
  };
  try {
    const walker = doc.createTreeWalker(container, SHOW_ELEMENT, accept);
    while (walker.nextNode()) { /* 收集发生在 accept 里 */ }
  } catch (_) { return null; }
  return tooBig ? null : out;
}

function barriersFor(container, rules, cache) {
  if (cache.has(container)) return cache.get(container);
  const list = scanBarriers(container, rules);
  cache.set(container, list);
  return list;
}

/** a 与 b 之间是否隔着屏障（屏障表为 null = 容器太大，放弃合并） */
function crossesBarrier(a, b, container, rules, cache) {
  const list = barriersFor(container, rules, cache);
  if (!list) return true;
  for (let i = 0; i < list.length; i++) if (isBetween(a, b, list[i])) return true;
  return false;
}

/**
 * 把一批（文档顺序的）文本节点切成翻译单元。
 * @returns {Array<{nodes:Text[], text:string, merged:boolean, container:Element|null}>}
 *   merged === true 的单元，回写前必须用 splitTranslation 切回片段。
 */
export function buildGroups(nodes, rules, opts = {}) {
  const maxSegments = opts.maxSegments || MERGE_MAX_SEGMENTS;
  const maxChars = opts.maxChars || MERGE_MAX_CHARS;
  const isSolo = typeof opts.isSolo === 'function' ? opts.isSolo : () => false;
  const out = [];
  const cache = new Map();
  let cur = null;
  for (const node of nodes || []) {
    if (!node || node.nodeType !== 3) continue;
    const text = node.data;
    let container = null;
    if (node.parentElement && text && !isSolo(node)) {
      try { container = nearestBlockContainer(node.parentElement, rules); } catch (_) { container = null; }
    }
    if (container && cur && cur.container === container &&
        cur.nodes.length < maxSegments && cur.chars + text.length + 1 <= maxChars &&
        !crossesBarrier(cur.nodes[cur.nodes.length - 1], node, container, rules, cache)) {
      cur.nodes.push(node);
      cur.parts.push(text);
      cur.chars += text.length + 1;
      continue;
    }
    cur = { container, nodes: [node], parts: [text], chars: text.length };
    out.push(cur);
  }
  return out.map((g) => ({
    container: g.container,
    nodes: g.nodes,
    parts: g.parts,          // 各节点的原文片段（异常隔离时用来判断哪些片段已经写出去）
    merged: g.nodes.length > 1,
    text: g.nodes.length > 1 ? g.parts.join(SEG) : g.parts[0]
  }));
}

/**
 * 把译文按片段分隔符切回各片段。
 * 片段数不符 / 出现空片段 / 分隔符被吞掉 -> 返回 null，调用方必须退回逐节点翻译。
 */
export function splitTranslation(translated, count) {
  const s = String(translated == null ? '' : translated);
  if (count <= 1) return [s.trim()];
  const parts = s.split(SEG);
  if (parts.length !== count) return null;
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) return null;
    out.push(t);
  }
  return out;
}
