// ---------- 回写层：只改 TextNode.data ----------
// 硬约束：整个回写路径只有 node.data = 译文 这一种写操作。
// 不新建节点、不删除节点、不移动节点，不用 innerHTML/outerHTML/replaceWith/insertAdjacentHTML，
// 也不改任何 display/flex/grid/position —— 布局与框架（React/lit/Vue）的 fiber 树原样不动。
//
// 记账三件套：
//   * written  : WeakMap<Text, 我们最后写进去的译文> —— 识别「自己触发的 mutation」，
//                同时是防重复翻译的 WeakSet 等价物（页面改写节点内容后比对立刻失效）；
//   * originals: Map<Text, 原文> —— 关闭翻译时逐节点还原，**不需要刷新页面**；
//   * elements : Set<Element> —— 打过标记的元素，还原时统一摘掉属性。
// 「行内 / 块级」的判定只有一处实现（rules.mjs），回写层与合并层共用同一套语义。
import { nearestBlockContainer } from './rules.mjs';

// 这些 display 下插入伪元素会多出一个盒子/条目而改变排版：双语标记跳过（元素照常翻译、照常打 done 标记）
const NO_PSEUDO_DISPLAYS = new Set([
  'flex', 'grid', 'inline-flex', 'inline-grid', 'contents', 'table', 'inline-table',
  'table-row', 'table-row-group', 'table-cell', 'list-item',
  'inline', 'inline-block', 'inline-table', 'ruby'
]);
const BILINGUAL_MAX_NODES = 400; // 双语标记只对「小容器」生效，避免整页级的子树遍历

/**
 * 保留原文首尾空白。
 * 一个句子被行内标签切成多个 TextNode 时（" and press " / " to continue."），
 * 引擎返回的译文通常是 trim 过的；丢掉首尾空格会让相邻片段粘在一起（"docs【译】and"）。
 * opts.keepLeading === false：句级重建里上一片段已经补了尾部空格，这里就不再补首部空格，
 * 避免行首出现两个连续空格（white-space: pre-wrap 下会看得出来）。
 */
export function keepBoundarySpace(text, orig, opts) {
  const o2 = opts || {};           // 调用方可能显式传 null（单节点单元 = 默认行为）
  const t = String(text == null ? '' : text);
  const o = String(orig == null ? '' : orig);
  if (!t.trim()) return t;
  let out = t.trim();
  if (o2.keepLeading !== false && /^\s/.test(o)) out = ' ' + out;
  if (/\s$/.test(o)) out = out + ' ';
  return out;
}

export class TextWriter {
  constructor({ mode = 'replace' } = {}) {
    this.mode = mode === 'bilingual' ? 'bilingual' : 'replace';
    this.written = new WeakMap();   // Text -> 译文
    this.originals = new Map();     // Text -> 原文（还原用）
    this.elements = new Set();      // 打过 data-ot-* 标记的元素
    this._display = new WeakMap();  // Element -> display（缓存，避免重复触发样式计算）
    this._tooBig = new WeakSet();   // 双语标记时跳过的大容器
  }

  /** 该文本节点当前内容是否就是我们写进去的译文（防止把自己写的内容再翻译一遍） */
  isOurs(node) {
    return !!(node && node.nodeType === 3 && this.written.get(node) === node.data);
  }

  hasOriginal(node) { return this.originals.has(node); }

  get count() { return this.originals.size; }

  /** 写入后该节点是否持有译文。原文与译文只有一处差异：node.data */
  write(node, translated, opts) {
    if (!node || node.nodeType !== 3 || !node.isConnected) return false;
    const raw = String(translated == null ? '' : translated);
    if (!raw.trim()) return false;
    const orig = this.originals.has(node) ? this.originals.get(node) : node.data;
    const text = keepBoundarySpace(raw, orig, opts);
    if (!this.originals.has(node)) this.originals.set(node, orig);
    try {
      if (node.data !== text) node.data = text;
    } catch (_) { return false; }
    this.written.set(node, text);
    const parent = node.parentElement;
    if (parent) {
      const container = this._containerOf(parent);
      if (container) {
        this._markDone(container);
        if (this.mode === 'bilingual') this._refreshBilingual(container);
      }
    }
    return true;
  }

  _displayOf(el) {
    const hit = this._display.get(el);
    if (hit !== undefined) return hit;
    let d = '';
    try {
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      if (win && win.getComputedStyle) d = String(win.getComputedStyle(el).display || '');
    } catch (_) {}
    this._display.set(el, d);
    return d;
  }

  /**
   * 翻译标记（data-ot-done）挂在「最近的块级祖先」上，而不是文本节点的直接父节点：
   * 一行文字被 <b>/<span> 包着时，标记应该落在段落/卡片这一层，人工排查和自动化断言才有意义。
   * 只挂属性、不做任何跳过门控 —— 容器被复用换入新文本时会重新翻译。
   */
  _containerOf(el) {
    // 与合并层共用同一个判定（rules.nearestBlockContainer），显示缓存走本层的 WeakMap
    return nearestBlockContainer(el, { displayCache: this._display });
  }

  _markDone(el) {
    if (el.hasAttribute && el.hasAttribute('data-ot-done')) return;
    try {
      el.setAttribute('data-ot-done', '1');
      this.elements.add(el);
    } catch (_) {}
  }

  /** 容器子树里的文本是否全部已译：是则按文档顺序返回拼接后的原文，否则 null */
  _subtreeOriginal(el) {
    if (this._tooBig.has(el)) return null;
    const parts = [];
    let texts = 0;
    let nodes = 0;
    let tooBig = false;
    let incomplete = false;
    const visit = (node) => {
      if (tooBig || incomplete) return;
      if (++nodes > BILINGUAL_MAX_NODES * 4) { tooBig = true; return; }
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (kid.nodeType === 3) {
          if (!kid.data || !kid.data.trim()) continue;
          if (++texts > BILINGUAL_MAX_NODES) { tooBig = true; return; }
          if (!this.written.has(kid)) { incomplete = true; return; } // 还有没译的文本 → 先不展示原文
          parts.push(this.originals.has(kid) ? this.originals.get(kid) : kid.data);
        } else if (kid.nodeType === 1) {
          visit(kid);
        }
      }
    };
    visit(el);
    if (tooBig) { this._tooBig.add(el); return null; }
    if (incomplete || !parts.length) return null;
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  /**
   * 双语对照：**只挂属性，不动 DOM**（原文由 CSS 伪元素 attr(data-ot-src) 渲染，
   * 伪元素不属于 DOM，React / lit 完全无感，也不会产生任何节点增删）。
   */
  _refreshBilingual(container) {
    if (!container || container.nodeType !== 1) return;
    const tag = container.tagName;
    if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD') return;
    if (container.isContentEditable) return;
    if (NO_PSEUDO_DISPLAYS.has(this._displayOf(container))) return;
    const src = this._subtreeOriginal(container);
    if (!src) return;
    try {
      container.setAttribute('data-ot-src', src);
      this.elements.add(container);
    } catch (_) {}
  }

  /** 切换显示方式：仅译文 / 双语对照。两种模式之间切换不需要刷新页面、不需要重排 DOM。 */
  setMode(mode) {
    const next = mode === 'bilingual' ? 'bilingual' : 'replace';
    if (next === this.mode) return;
    this.mode = next;
    for (const el of this.elements) {
      if (!el.isConnected) continue;
      try {
        if (next === 'bilingual') this._refreshBilingual(el);
        else el.removeAttribute('data-ot-src');
      } catch (_) {}
    }
  }

  /** 还原原文并摘掉所有标记（关闭整页翻译时调用） */
  restoreAll() {
    let n = 0;
    for (const [node, orig] of this.originals) {
      try {
        if (node.isConnected && node.data !== orig) { node.data = orig; n++; }
      } catch (_) {}
    }
    for (const el of this.elements) {
      try { el.removeAttribute('data-ot-done'); el.removeAttribute('data-ot-src'); } catch (_) {}
    }
    this.originals.clear();
    this.elements.clear();
    this.written = new WeakMap();
    this._display = new WeakMap();
    this._tooBig = new WeakSet();
    return n;
  }

  /** 丢掉已经从文档里摘除的节点（长会话 / 无限滚动下的内存回收） */
  prune() {
    let dropped = 0;
    for (const [node] of this.originals) {
      if (!node.isConnected) { this.originals.delete(node); dropped++; }
    }
    for (const el of this.elements) {
      if (!el.isConnected) this.elements.delete(el);
    }
    return dropped;
  }
}
