// ---------- MutationObserver 层：动态内容 / 无限滚动 / 虚拟列表回流 ----------
// 一个观察者同时挂在 document 和所有 open shadow root 上：
//   childList   → 新增子树交给提取层重新走 TreeWalker；
//   characterData → 页面原位改写文本（React 复用节点最常见）→ 直接重新翻译这个文本节点。
// 自己写进去的译文会被 isOurs() 识别并忽略，因此不会出现「翻译 → DOM 变化 → 再翻译」死循环。
export class DomWatcher {
  constructor({ doc, isOurs, onChange, delay = 180, maxRoots = 300, maxTexts = 800 }) {
    this.doc = doc;
    this.isOurs = typeof isOurs === 'function' ? isOurs : () => false;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.delay = delay;
    this.maxRoots = maxRoots;
    this.maxTexts = maxTexts;
    this.observer = null;
    this.observed = new WeakSet();
    this.shadowCount = 0;
    this.stats = { mutations: 0, flushes: 0 };
    this._roots = [];
    this._texts = [];
    this._timer = null;
    this._onMutations = (muts) => this._handle(muts);
  }

  start() {
    if (this.observer) return;
    this.observer = new MutationObserver(this._onMutations);
    this.observeNode(this.doc.documentElement);
  }

  /** 观察一个根（documentElement 或某个 shadow root） */
  observeNode(node) {
    if (!this.observer || !node || this.observed.has(node)) return false;
    this.observed.add(node);
    try {
      this.observer.observe(node, { childList: true, subtree: true, characterData: true });
    } catch (_) { return false; }
    if (node.nodeType === 11 && node.host) this.shadowCount++;
    return true;
  }

  stop() {
    if (this.observer) { try { this.observer.disconnect(); } catch (_) {} }
    this.observer = null;
    this.observed = new WeakSet();
    this.shadowCount = 0;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._roots = [];
    this._texts = [];
  }

  _handle(muts) {
    this.stats.mutations++;
    for (const m of muts) {
      if (m.type === 'characterData') {
        const t = m.target;
        if (t && t.nodeType === 3 && !this.isOurs(t)) this._pushText(t);
        continue;
      }
      if (m.type !== 'childList') continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) this._pushRoot(n);
        else if (n.nodeType === 3 && !this.isOurs(n)) this._pushText(n);
      }
    }
    if (!this._roots.length && !this._texts.length) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), this.delay);
  }

  _pushText(node) {
    if (this._texts.indexOf(node) >= 0) return;
    if (this._texts.length >= this.maxTexts) return; // 极端批量改写：交给兜底整页重扫
    this._texts.push(node);
  }

  _pushRoot(node) {
    if (this._roots.length >= this.maxRoots) return;
    this._roots.push(node);
  }

  _flush() {
    this._timer = null;
    const texts = this._texts; this._texts = [];
    const roots = this._dedupe(this._roots); this._roots = [];
    if (!texts.length && !roots.length) return;
    this.stats.flushes++;
    this.onChange({ roots, texts });
  }

  /** 去掉被同批其它根包含的根（一次插入整棵子树时避免重复扫描） */
  _dedupe(list) {
    const keep = [];
    for (const node of list) {
      if (!node.isConnected) continue;
      let nested = false;
      for (const other of list) {
        if (other !== node && other.contains && other.contains(node)) { nested = true; break; }
      }
      if (!nested && keep.indexOf(node) < 0) keep.push(node);
    }
    return keep;
  }
}
