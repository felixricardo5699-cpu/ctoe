// ---------- 划词翻译浮层 ----------
import { el, clearChildren } from './misc.mjs';
import { BRIDGE_WAKE_TIMEOUT_MS, WAKE_URL, makeRequestId } from './bridge.mjs';

export class SelectionTranslator {
  constructor(ctx) {
    this.doc = ctx.doc;
    this.win = ctx.win;
    this.translator = ctx.translator;
    this.settings = ctx.settings;
    this.enabled = this.settings.selTranslate;
    this.pinned = this.settings.selPopupPinned;
    this._armed = false;
    this._mouseUpAt = 0;
    this.card = null;
    this.curText = '';
    this._lastX = 0;
    this._lastY = 0;
    this._seq = 0;
  }

  setEnabled(on) { this.enabled = !!on; if (!on) this.hide(); }

  start() {
    this.doc.addEventListener('mouseup', (e) => { this._mouseX = e.clientX; this._mouseY = e.clientY; this._onMouseUp(e); }, true);
    this.doc.addEventListener('keyup', (e) => this._onKey(e), true);
    this.doc.addEventListener('selectionchange', () => this._schedule());
    this.win.addEventListener('scroll', () => { if (!this.pinned && this.card) this.hide(); }, { passive: true, capture: true });
  }

  /**
   * 只有按住 Ctrl+Shift 划词才弹浮层（macOS 用 Cmd+Shift）。
   *
   * 选中一段文字是网页上最普通的手势：复制、引用、查词都会选中。不加区分就等于到处都是浮层，
   * 而这个浮层底部还有「学习这句」——误触的代价不只是挡住视线。闸门设在这里，防抖那条路
   * （selectionchange）只认这个标记，不会自己冒出来。
   */
  _onMouseUp(e) {
    this._mouseUpAt = Date.now();
    this._armed = !!(e && (e.ctrlKey || e.metaKey) && e.shiftKey);
    const sel = this.win.getSelection && this.win.getSelection();
    if (!sel || sel.rangeCount === 0 || String(sel).length === 0) {
      // 点击别处时收起（除非固定）
      if (!this.pinned && this.card) setTimeout(() => { if (!this._selectionActive()) this.hide(); }, 120);
      return;
    }
    if (!this._armed) {
      // 普通划词：不弹新的，顺手把上一次留下的收掉。
      if (!this.pinned && this.card) this.hide();
      return;
    }
    const text = String(sel).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1200) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const x = rect && rect.width ? rect.right : this._lastX;
    const y = rect && rect.height ? rect.bottom : this._lastY;
    this.show(text, { x, y, mode: 'pop' });
  }

  _onKey(e) {
    const k = e.key;
    if (k === 'Escape') { this.hide(); return; }
    if ((k === 'c' || k === 'C') && (e.ctrlKey || e.metaKey)) {
      // 复制后保留小卡但不自动翻译
    }
    // 松键顺序容错：先松开 Ctrl 或 Shift、后松鼠标时，mouseup 上读不到修饰键，
    // 上面那道判定会把这当成普通划词。此刻另一个修饰键还按着，且鼠标刚松开——
    // 这就是同一次 Ctrl+Shift 划词，补记一次。
    const justSelected = Date.now() - this._mouseUpAt < 600;
    if (justSelected && k === 'Shift' && (e.ctrlKey || e.metaKey)) this._armed = true;
    if (justSelected && (k === 'Control' || k === 'Meta') && e.shiftKey) this._armed = true;
    this._schedule();
  }

  _schedule() {
    if (!this.enabled) return;
    // 闸门：只有 Ctrl+Shift 划词那一次手势会放行，防抖这条路过不来。
    if (!this._armed) return;
    setTimeout(() => {
      const sel = this.win.getSelection && this.win.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const text = String(sel).replace(/\s+/g, ' ').trim();
      if (!text || text.length > 1200) return;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const x = rect && rect.width ? rect.right : this._lastX;
      const y = rect && rect.height ? rect.bottom : this._lastY;
      if (this.card && this.pinned) { this.updateText(text); return; }
      if (this.card && this.curText === text) { this._position(x, y); return; }
      this.show(text, { x, y, mode: 'pop' });
    }, 260);
  }

  _selectionActive() {
    const sel = this.win.getSelection && this.win.getSelection();
    return !!(sel && sel.rangeCount && String(sel).trim());
  }

  show(text, { x = 0, y = 0 } = {}) {
    if (!this.enabled || !text) return;
    if (this.card && !this.pinned) this.hide();
    this.curText = text;
    this._lastX = x; this._lastY = y;
    if (!this.card) {
      this.card = el('div', { id: 'ot-sel-card', class: 'ot-ui ot-sel' });
      this.doc.documentElement.appendChild(this.card);
    }
    clearChildren(this.card);
    const head = el('div', { class: 'ot-sel-head' });
    head.append(el('span', { class: 'ot-sel-title' }, '划词翻译'), el('span', { class: 'ot-sel-actions' }, [
      el('button', { class: 'ot-btn ot-pin', title: '固定（自动跟随后续划词）' }, this.pinned ? '📌' : '📍'),
      el('button', { class: 'ot-btn ot-copy', title: '复制译文' }, '⧉'),
      el('button', { class: 'ot-btn ot-close', title: '关闭' }, '✕')
    ]));
    const body = el('div', { class: 'ot-sel-body' }, [el('div', { class: 'ot-sel-src' }, text), el('div', { class: 'ot-sel-dst' }, '…')]);
    const foot = el('div', { class: 'ot-sel-foot' });
    // 浮层底部原来什么也不放，正好是「学习这句」的位置：用户已经选中了句子，
    // 也看过了译文，这里是唯一一个「我想记住它」的自然时机。
    if (this._coachOn()) {
      const learn = el('button', { class: 'ot-btn ot-learn', title: '发送到 AI Language Coach 学习这句话' }, '学习这句');
      learn.addEventListener('click', () => this._learnSentence(learn));
      foot.append(learn);
    }
    this.card.append(head, body, foot);
    this.card.querySelector('.ot-close').addEventListener('click', () => this.hide());
    this.card.querySelector('.ot-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this._resultText || this.curText); } catch (_) {}
    });
    const pinBtn = this.card.querySelector('.ot-pin');
    pinBtn.addEventListener('click', () => {
      this.pinned = !this.pinned;
      pinBtn.textContent = this.pinned ? '📌' : '📍';
      pinBtn.title = this.pinned ? '取消固定' : '固定（自动跟随后续划词）';
      if (this.pinned) this.card.classList.add('ot-pinned');
      else this.card.classList.remove('ot-pinned');
    });
    if (this.pinned) this.card.classList.add('ot-pinned');
    this._position(x, y);
    this._doTranslate(text);
  }

  _position(x, y) {
    if (!this.card || this.pinned) { if (this.card) this.card.style.transform = ''; return; }
    const pad = 12;
    const cw = this.card.offsetWidth || 260;
    const ch = this.card.offsetHeight || 120;
    const vw = this.win.innerWidth;
    const vh = this.win.innerHeight;
    let left = x + 8;
    let top = y + 8;
    if (left + cw > vw - pad) left = Math.max(pad, x - cw - 8);
    if (top + ch > vh - pad) top = Math.max(pad, y - ch - 8);
    this.card.style.left = left + 'px';
    this.card.style.top = top + 'px';
  }

  updateText(text) {
    if (!this.card) return;
    if (text === this.curText) return;
    this.curText = text;
    const srcEl = this.card.querySelector('.ot-sel-src');
    const dstEl = this.card.querySelector('.ot-sel-dst');
    if (srcEl) srcEl.textContent = text;
    if (dstEl) { dstEl.textContent = '…'; dstEl.classList.remove('ot-done', 'ot-err'); }
    this._doTranslate(text);
  }

  async _doTranslate(text) {
    const seq = ++this._seq;
    this._resultText = '';
    const dstEl = this.card && this.card.querySelector('.ot-sel-dst');
    if (dstEl) { dstEl.textContent = '翻译中…'; dstEl.classList.add('ot-loading'); }
    const result = await this.translator.translateText(text);
    if (seq !== this._seq || !this.card) return;
    if (dstEl) {
      dstEl.classList.remove('ot-loading');
      if (result) {
        this._resultText = result;
        dstEl.textContent = result;
        dstEl.classList.add('ot-done');
        if (this.win.getSelection) {
          try {
            const sel = this.win.getSelection();
            if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
          } catch (_) {}
        }
      } else {
        dstEl.textContent = '翻译失败（请检查网络或更换引擎）';
        dstEl.classList.add('ot-err');
      }
    }
  }

  _coachOn() {
    return !!(this.settings && this.settings.coach && this.settings.coach.enabled !== false);
  }

  /**
   * 浮层底部的「学习这句」：用户点一下才发，发完把结果写回按钮本身。
   * 失败原因放 title：浮层只有 260px 宽，长句子塞不进去。
   */
  async _learnSentence(btn) {
    if (!btn || btn.disabled) return;
    const text = this.curText;
    if (!text) return;
    btn.disabled = true;
    try {
      // 无论走哪条分支都要把按钮放回来，否则一次异常就让这个按钮永久变灰。
      await this._learnText(text, (ok, label, detail) => this._setLearnResult(btn, ok, label, detail));
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * 右键菜单那条路：不在浮层里发，改用页面右下角的一条回执。
   * 返回 { ok, message } 给 SW（它只记录、不展示），页面上的提示由 _toast 画。
   *
   * 它叫不醒没在跑的桌面端，原因见 _learnText 里的 canWake。
   */
  async learnFromMenu(text) {
    const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!clean) return { ok: false, message: '没有可学习的文本。' };
    const outcome = { ok: false, message: '' };
    this._toast('正在发送到 AI Language Coach…', null);
    await this._learnText(clean, (ok, label, detail) => {
      outcome.ok = ok === true;
      outcome.message = detail || label;
      // ok === null 是「还在路上」：这时候 label 本身就是那句话（发送中… / 正在打开桌面端…），
      // 不能再加一个 ✗ —— 那会让一个正在进行的请求看起来已经失败了。
      this._toast(ok === false ? '✗ ' + (detail || '学习失败') : label, ok);
    }, false);
    return outcome;
  }

  /**
   * 一次学习，两个入口共用：探测 → 必要时点门铃 → 发送 → 等结果。
   * 唯一的差别是把结果画在哪儿：浮层按钮上，还是页面右下角的一条提示。
   * report(ok, label, detail)；ok 为 null 表示还在路上（既不是成功也不是失败）。
   *
   * canWake 说的是「这一次点击能不能唤起桌面端」。浮层按钮是页面里的一次真点击，页面还握着
   * 那份手势，所以 ctoe:// 点得动；右键菜单的点击发生在浏览器界面上，页面从来没有拿到手势，
   * 合成 click() 也就唤不动任何东西——与其干等 20 秒再报一个含糊的失败，不如当场说清楚。
   *
   * 这里只跟 SW 说话、不直接 fetch：页面 CSP 的 connect-src 管不到 SW。
   */
  async _learnText(text, report, canWake) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      report(false, '✗ 扩展未就绪', '内容脚本拿不到扩展运行时，请重新加载页面。');
      return;
    }
    const mayWake = canWake !== false;
    // 一次点击 = 一个 requestId，重试也用同一个：桌面端 60 秒幂等窗口保证这句只学一次。
    const requestId = makeRequestId();
    const payload = {
      text,
      url: (this.doc.location && this.doc.location.href) || '',
      title: this.doc.title || '',
      langHint: (this.doc.documentElement && this.doc.documentElement.lang) || ''
    };
    try {
      report(null, '发送中…', '正在发送到桌面端');
      let res = await this._askCoach({ ...payload, requestId, prewake: true });
      // 桌面端没在跑的时候，HTTP 是叫不醒它的——只有 ctoe:// 门铃能，而且必须由这一次点击来点：
      // 手势是浏览器允许唤起外部程序的唯一理由。
      if (res && res.reason === 'not-listening') {
        if (!mayWake) {
          report(false, '✗ 桌面端没在运行', '请先打开 AI Language Coach；或者按住 Ctrl+Shift 划词再点「学习这句」，浏览器只允许那样唤起它。');
          return;
        }
        report(null, '正在打开桌面端，最多等 20 秒…', '正在唤起 AI Language Coach，请在弹出的提示里允许打开。');
        if (this._wakeDesktop()) {
          res = await this._askCoach({ ...payload, requestId, waitForMs: BRIDGE_WAKE_TIMEOUT_MS });
        }
      }
      if (res && res.ok && res.state === 'learned') {
        report(true, res.label ? '✓ 已学习 ' + res.label : '✓ 已学习', '已保存到桌面端的 My Learning');
      } else if (res && res.message) {
        report(false, '✗ 学习失败', res.message);
      } else {
        report(false, '✗ 学习失败', '没有连接到 AI Language Coach，请确认桌面端已启动。');
      }
    } catch (_e) {
      report(false, '✗ 学习失败', '发送失败，请稍后重试。');
    }
  }

  /** 只跟 SW 说话、不直接 fetch：页面 CSP 的 connect-src 管不到 SW。 */
  async _askCoach(message) {
    try {
      return await chrome.runtime.sendMessage({ type: 'ot-learn-sentence', ...message });
    } catch (_e) {
      return null;
    }
  }

  /**
   * 点一次门铃。
   *
   * 用真 anchor + click：这是用户点击（手势）触发的导航请求，浏览器才会把 ctoe:// 交给系统；
   * fetch 不支持自定义协议，iframe 会被拦。门铃不携带任何东西——句子照旧走带口令的桥接。
   * 返回 false 表示这次点不成（没有 body、浏览器拒绝），调用方据此不再白等。
   */
  _wakeDesktop() {
    try {
      const a = el('a', { href: WAKE_URL, style: 'display:none' });
      a.setAttribute('rel', 'noopener');
      (this.doc.body || this.doc.documentElement).append(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (_e) { /* 已经不在文档里了 */ } }, 0);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * 页面右下角的一条回执。右键入口没有浮层可写，而「点了到底成没成」必须看得见：
   * 成功要说，失败更要说清楚为什么。成功 / 失败 3.6 秒后自己消失，进行中留 8 秒。
   * 不拦点击（pointer-events: none），也不改页面布局。
   */
  _toast(text, ok) {
    try {
      let box = this.doc.getElementById('ot-coach-toast');
      if (!box) {
        box = el('div', { id: 'ot-coach-toast', class: 'ot-ui ot-coach-toast' });
        this.doc.documentElement.append(box);
      }
      box.textContent = text;
      box.classList.toggle('ot-ok', ok === true);
      box.classList.toggle('ot-err', ok === false);
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        try { box.remove(); } catch (_e) { /* 已经不在文档里了 */ }
        this._toastTimer = null;
      }, ok === null ? 8000 : 3600);
    } catch (_e) { /* 页面不让挂就不挂：学习本身不受影响 */ }
  }

  _setLearnResult(btn, ok, label, detail) {
    btn.textContent = label;
    btn.title = detail || label;
    btn.classList.toggle('ot-ok', ok === true);
    btn.classList.toggle('ot-err', ok === false);
  }

  hide() {
    if (!this.card) return;
    this.card.remove();
    this.card = null;
    this._seq++;
    this.curText = '';
  }
}
