// ---------- 图片翻译：点图即译 → 图内底部统一翻译面板 ----------
// 硬约束（React/lit 站点）：**绝不碰页面的 DOM**。
// 旧实现把 <img> 从原父节点搬进新建的 .ot-img-box 容器 —— 这就是「搬动框架持有的节点」，
// 框架（React / lit）在重渲染时的 removeChild 会抛 NotFoundError 直接白屏，所以页面节点一律不动。
// 现在：浮层挂在 <html> 下的独立层里（插件自己的层，页面结构一个节点都不动），
// 用「文档绝对定位」覆盖在图片位置上，尺寸/位置实时跟随图片的 getBoundingClientRect()。
// OCR / 翻译引擎 / 插件通信保持不变。
import { el, clearChildren } from './misc.mjs';

function bytesToB64(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}


export class ImageTranslator {
  constructor(ctx) {
    this.doc = ctx.doc;
    this.win = ctx.win;
    this.translator = ctx.translator;
    this.settings = ctx.settings;
    this.enabled = !!ctx.settings.imgTranslate;
    this.entries = new Map();      // img -> entry
    this._ro = null;
    this._rafTick = null;
    this._parents = new Map();      // parent element -> Set<entry>
    this._resizeHandler = () => this._scheduleLayout();
    this._scrollHandler = () => { if (this.entries.size) this._scheduleLayout(); };
    // 浮层是 <html> 层的绝对定位元素：滚动/缩放/布局变化都要重新贴合图片
    this.doc.addEventListener('scroll', this._scrollHandler, { passive: true, capture: true });
    this.win.addEventListener('resize', this._resizeHandler, { passive: true });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._applyListeners();
    if (!on) this.clearOverlay();
  }

  start() { this._applyListeners(); }

  _applyListeners() {
    if (this.enabled) {
      this.doc.addEventListener('click', this._onClick, true);
      this.doc.addEventListener('pointerover', this._onOver, true);
      this.doc.addEventListener('pointerout', this._onOut, true);
    } else {
      this.doc.removeEventListener('click', this._onClick, true);
      this.doc.removeEventListener('pointerover', this._onOver, true);
      this.doc.removeEventListener('pointerout', this._onOut, true);
    }
  }

  _onClick = (e) => {
    if (!this.enabled) return;
    const t = e.target;
    if (!t || !t.tagName) return;
    if ((t.id && String(t.id).indexOf('ot-') === 0) || (t.closest && t.closest('.ot-ui'))) return;
    const img = t.tagName === 'IMG' ? t : (t.closest && t.closest('img'));
    if (!img || !img.isConnected) return;
    const src = img.currentSrc || img.src || '';
    if (!src || /\.gif(\?|#|$)/i.test(src)) return;
    e.preventDefault(); e.stopPropagation();
    this._begin(img, src);
  };

  _onOver = (e) => {
    if (!this.enabled) return;
    const i = e.target && e.target.closest ? e.target.closest('img') : null;
    if (i && !this.entries.has(i)) i.classList.add('ot-img-hover');
  };
  _onOut = (e) => {
    if (!this.enabled) return;
    const i = e.target && e.target.closest ? e.target.closest('img') : null;
    if (i) i.classList.remove('ot-img-hover');
  };

  _ensureResizeObserver() {
    if (this._ro) return this._ro;
    this._ro = new ResizeObserver((list) => {
      for (const item of list) {
        const entry = item.target && item.target.__otEntry;
        if (entry) { this._mark(entry); continue; }
        const set = this._parents.get(item.target);
        if (set) for (const en of set) this._mark(en);
      }
    });
    return this._ro;
  }

  /**
   * 创建浮层：只往插件自己的层（<html>）里加节点，页面里一个节点都不动。
   * 图片既不换父节点、也不改内联样式 —— 框架完全无感。
   */
  _createBox(img) {
    const doc = this.doc;
    const box = doc.createElement('div');
    box.className = 'ot-ui ot-img-box';
    box.setAttribute('data-ot-float', '1');

    const overlay = doc.createElement('div');
    overlay.className = 'ot-img-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    box.appendChild(overlay);

    const ctrl = doc.createElement('div');
    ctrl.className = 'ot-img-ctrl';
    const tgl = doc.createElement('button');
    tgl.type = 'button'; tgl.className = 'ot-btn ot-img-toggle'; tgl.textContent = '译/原';
    tgl.title = '切换 译文/原文';
    const close = doc.createElement('button');
    close.type = 'button'; close.className = 'ot-btn ot-img-close'; close.textContent = '✕';
    close.title = '取消本图翻译（还原）';
    ctrl.append(tgl, close);
    box.appendChild(ctrl);

    doc.documentElement.appendChild(box);

    const r = img.getBoundingClientRect();
    const entry = {
      img, box, overlay, ctrl,
      naturalW: img.naturalWidth || 0, naturalH: img.naturalHeight || 0,
      baseW: r.width || 1, baseH: r.height || 1
    };
    box.__otEntry = entry;
    tgl.addEventListener('click', (ev) => { ev.stopPropagation(); entry.box.classList.toggle('ot-show-orig'); tgl.classList.toggle('on'); });
    close.addEventListener('click', (ev) => { ev.stopPropagation(); this.removeEntry(entry); });

    this._fitWrapper(entry);
    // 图片尺寸变化（响应式缩放）与父容器重排都要跟随
    try { this._ensureResizeObserver().observe(img); } catch (_) {}
    entry.parentEl = img.parentElement;
    this._registerParent(entry.parentEl, entry);
    this._mark(entry);
    return entry;
  }

  /** 浮层始终与图片当前渲染位置/尺寸一致（文档坐标，滚动天然跟随） */
  _fitWrapper(entry) {
    const { img, box } = entry;
    if (!img || !img.isConnected) { this.removeEntry(entry); return; }
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) { box.style.display = 'none'; return; }
    box.style.display = '';
    const sx = this.win.scrollX || 0;
    const sy = this.win.scrollY || 0;
    box.style.left = Math.round(r.left + sx) + 'px';
    box.style.top = Math.round(r.top + sy) + 'px';
    box.style.width = Math.round(r.width) + 'px';
    box.style.height = Math.round(r.height) + 'px';
  }

  // 观察图片所在父元素：父级宽度变化（响应式重排）时，浮层也跟随缩放
  _registerParent(parent, entry) {
    if (!parent || !entry) return;
    if (!this._parents.has(parent)) this._parents.set(parent, new Set());
    const set = this._parents.get(parent);
    if (set.has(entry)) return;
    set.add(entry);
    try { this._ensureResizeObserver().observe(parent); } catch (_) {}
  }

  async _begin(img, src) {
    const existed = this.entries.get(img);
    if (existed) { this.removeEntry(existed); return; }
    this._clearHover(img);
    const entry = this._createBox(img);
    this.entries.set(img, entry);
    const st = el('div', { class: 'ot-img-status' }, '正在识别图片文字…');
    entry.overlay.appendChild(st);
    await this._ocrAndRender(img, src, entry);
  }

  _clearHover(img) { if (img) img.classList.remove('ot-img-hover'); }

  removeEntry(entry) {
    if (!entry) return;
    if (this._ro) {
      try { this._ro.unobserve(entry.box); } catch (_) {}
      try { this._ro.unobserve(entry.img); } catch (_) {}
    }
    if (entry.parentEl && this._parents.has(entry.parentEl)) {
      const set = this._parents.get(entry.parentEl);
      set.delete(entry);
      if (!set.size) {
        this._parents.delete(entry.parentEl);
        try { this._ro.unobserve(entry.parentEl); } catch (_) {}
      }
    }
    const { img, box } = entry;
    // 页面里从未被改过，只需摘掉插件自己的浮层
    if (box && box.parentNode) box.remove();
    if (this.entries.get(img) === entry) this.entries.delete(img);
    this._clearHover(img);
  }

  clearOverlay() {
    for (const entry of [...this.entries.values()]) this.removeEntry(entry);
    this.entries.clear();
  }

  // ------- OCR / 翻译（保持不变） -------
  async _fetchImageData(src) {
    if (/^data:/.test(src)) return src.split(',')[1] || null;
    const u = new URL(src, location.href);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ot-fetch-image', url: u.href });
      if (resp && resp.ok && resp.base64) return resp.base64;
    } catch (_) {}
    try {
      const res = await fetch(u.href);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return bytesToB64(new Uint8Array(buf));
    } catch (_) { return null; }
  }

  _mimeOf(src) {
    if (/^data:/.test(src)) { const m = src.match(/^data:([^;,]+)/); return m ? m[1] : 'image/png'; }
    const m = src.match(/\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i);
    if (m) { const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }; return map[m[1].toLowerCase()]; }
    return 'image/png';
  }

  async _ocrAndRender(img, src, entry) {
    const b64 = await this._fetchImageData(src);
    if (!b64) { this._showError(entry, '无法读取图片（跨域/加载失败），请对图片右键 → “翻译此图片” 或等待图片加载完重试。'); return; }
    const dataUrl = 'data:' + this._mimeOf(src) + ';base64,' + b64;
    try {
      const job = 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const ocr = this.settings.ocr || {};
      const resp = await chrome.runtime.sendMessage({ type: 'ot-ocr', job, image: dataUrl, langs: ocr.lang || 'eng', ocrMode: ocr.mode || 'tesseract' });
      if (!resp || !resp.ok) { this._showError(entry, (resp && resp.error ? 'OCR 识别失败：' + String(resp.error).slice(0, 220) : 'OCR 识别失败')); return; }
      await this._renderOverlay(entry, resp);
    } catch (e) { this._showError(entry, '图片翻译调用失败：' + (e && e.message)); }
  }

  // ------- 渲染：把全部 OCR 译文合并为一个底部翻译面板 -------
  async _renderOverlay(entry, resp) {
    if (!entry || !entry.overlay || !entry.overlay.isConnected) return;
    clearChildren(entry.overlay);
    const lines = (resp.lines || []).filter((l) => l && l.text && l.text.trim());
    if (!lines.length) { this._showError(entry, '未在图内识别到可翻译文字。'); return; }
    // OCR 逻辑与翻译 API 调用保持不变
    const uniq = [...new Set(lines.map((l) => l.text.trim()).filter(Boolean))];
    let ok = new Map();
    try { ok = (await this.translator.engine.translateMany(uniq)).ok; } catch (_) {}
    const items = lines
      .map((l) => ({ text: l.text.trim(), tr: ok.get(l.text.trim()), bbox: l.bbox || null }))
      .filter((it) => it.tr);
    if (!items.length) { this._showError(entry, '未能翻译图中文字（未识别到可翻译文本）。'); return; }
    // 合并成普通文本：同一视觉行的条目用空格连接（如 Trade + Rumors → Trade Rumors），不同行之间换行
    const cyOf = (it) => (it.bbox ? (it.bbox.y0 + it.bbox.y1) / 2 : Number.MAX_SAFE_INTEGER);
    items.sort((a, b2) => cyOf(a) - cyOf(b2));
    const rows = [];
    for (const it of items) {
      const cy = cyOf(it);
      const bh = it.bbox ? (it.bbox.y1 - it.bbox.y0) : 0;
      const last = rows.length ? rows[rows.length - 1] : null;
      if (last && last.cy !== Number.MAX_SAFE_INTEGER && cy !== Number.MAX_SAFE_INTEGER && Math.abs(cy - last.cy) <= Math.max(6, (last.h + bh) / 3)) {
        last.items.push(it.tr);
      } else {
        rows.push({ cy, h: bh, items: [it.tr] });
      }
    }
    const text = rows.map((r) => r.items.join(' ')).join('\n').replace(/[ \t]+\n/g, '\n').trim();
    if (!text) { this._showError(entry, '未能翻译图中文字（未识别到可翻译文本）。'); return; }
    // 统一字号与排版：由 CSS 固定（不还原 OCR 字号），不再按 bbox 生成多个文本框
    const panel = el('div', { class: 'ot-trans-panel' });
    panel.textContent = text;
    panel.title = text.replace(/\n/g, ' ');
    entry.overlay.appendChild(panel);
    this._mark(entry);
  }

  _showError(entry, msg) {
    if (!entry || !entry.overlay || !entry.overlay.isConnected) return;
    const old = entry.overlay.querySelector('.ot-img-status');
    if (old) old.remove();
    const st = el('div', { class: 'ot-img-status ot-err' }, msg);
    entry.overlay.appendChild(st);
    this._mark(entry);
  }

  // ------- 布局：rAF 合并，保证跟随图片 -------
  _mark(entry) { if (entry) this._scheduleLayout(); }

  _scheduleLayout() {
    if (this._rafTick) return;
    this._rafTick = this.win.requestAnimationFrame(() => {
      this._rafTick = null;
      for (const entry of [...this.entries.values()]) this._fitWrapper(entry);
    });
  }
}
