// ---------- 页面悬浮面板（右下角入口 + 控制卡） ----------
import { el } from './misc.mjs';

/**
 * 面板卡片：**用 DOM 构建，不用 innerHTML**。
 * 插件的 UI 虽然不参与网页翻译，但这里同样遵守仓库的硬约束：
 * 页面翻译链路与插件 UI 都不出现 innerHTML / outerHTML —— 少一条注入面，也便于静态审查。
 */
function buildCard() {
  const modeRow = el('div', { class: 'ot-mode-row', role: 'radiogroup', 'aria-label': '翻译显示方式' }, [
    el('button', { class: 'ot-mode-btn', 'data-mode': 'replace' }, '仅译文'),
    el('button', { class: 'ot-mode-btn', 'data-mode': 'bilingual' }, '双语对照')
  ]);
  const selSwitch = el('label', { class: 'ot-switch ot-switch-sel' }, [
    Object.assign(el('input', { type: 'checkbox' }), { checked: true }),
    el('span', { class: 'ot-switch-slider' }),
    el('span', { class: 'ot-switch-label' }, '划词翻译（Ctrl+Shift 划词即译）')
  ]);
  const imgSwitch = el('label', { class: 'ot-switch ot-switch-img' }, [
    el('input', { type: 'checkbox' }),
    el('span', { class: 'ot-switch-slider' }),
    el('span', { class: 'ot-switch-label' }, '图片翻译（点图即译）')
  ]);
  return el('div', { id: 'ot-panel', class: 'ot-ui ot-panel' }, [
    el('div', { class: 'ot-panel-head' }, [
      el('span', { class: 'ot-panel-title' }, 'OmniTranslate 万译'),
      el('span', { class: 'ot-host' }),
      el('button', { class: 'ot-btn ot-panel-close', title: '收起面板' }, '✕')
    ]),
    el('div', { class: 'ot-panel-body' }, [
      el('div', { class: 'ot-status' }, '…'),
      el('button', { class: 'ot-btn ot-btn-translate ot-block ot-primary' }, '☰ 一键翻译本页'),
      modeRow,
      selSwitch,
      imgSwitch,
      el('div', { class: 'ot-panel-tip' }, '提示：滚动加载 / 动态插入的新内容会自动翻译，译文不会因滚动消失。')
    ]),
    el('div', { class: 'ot-panel-foot' }, [
      el('button', { class: 'ot-btn ot-panel-settings' }, '⚙ 更多设置'),
      el('button', { class: 'ot-btn ot-btn-reload' }, '↻ 刷新页面')
    ])
  ]);
}

export class Panel {
  constructor(ctx) {
    this.doc = ctx.doc;
    this.win = ctx.win;
    this.ctrl = ctx.controller;
    this.fab = null;
    this.card = null;
    this.lastStatus = { phase: 'idle', enabled: false, pending: 0, done: 0, failed: 0 };
  }

  updateStatus(status) {
    this.lastStatus = { ...this.lastStatus, ...status };
    this._renderFab();
    this._renderCard();
  }

  mount() {
    if (this.fab || this.doc.getElementById('ot-fab')) return;
    this.fab = el('button', { id: 'ot-fab', class: 'ot-ui ot-fab', title: 'OmniTranslate 万译 — 点击打开' }, [
      el('span', { class: 'ot-fab-dot' }),
      el('span', { class: 'ot-fab-ico' }, '译')
    ]);
    this.fab.addEventListener('click', () => { this.isOpen() ? this._close() : this._open(); });
    this.doc.documentElement.appendChild(this.fab);
    this._renderFab();
  }

  /**
   * 面板是否开着：状态从 DOM 读，不另存一份。
   *
   * 之前这里是 this.opened，而它从构造后再没被写过，于是球永远走「打开」那一支，
   * 点第二次没有反应——面板收不起来就是这个原因。读 DOM 就不可能不同步。
   */
  isOpen() {
    return !!(this.card && this.card.classList.contains('ot-open'));
  }

  _open() {
    if (!this.card) {
      this.card = buildCard();
      this.doc.documentElement.appendChild(this.card);
      this._bind();
    }
    this.card.classList.add('ot-open');
    this._renderCard();
  }

  _close() { if (this.card) this.card.classList.remove('ot-open'); }

  _bind() {
    const head = this.card.querySelector('.ot-panel-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, l: this.card.offsetLeft, t: this.card.offsetTop };
      const move = (ev) => {
        if (!drag) return;
        this.card.style.left = Math.max(0, drag.l + ev.clientX - drag.x) + 'px';
        this.card.style.top = Math.max(0, drag.t + ev.clientY - drag.y) + 'px';
        this.card.style.right = 'auto';
        this.card.style.bottom = 'auto';
      };
      const up = () => { drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    const host = this.card.querySelector('.ot-host');
    if (host) { try { host.textContent = location.hostname.replace(/^www\./, ''); } catch (_) {} }
    this.card.querySelector('.ot-btn-translate').addEventListener('click', () => {
      this.ctrl.togglePage();
      setTimeout(() => this._renderCard(), 80);
    });
    this.card.querySelector('.ot-btn-reload').addEventListener('click', () => this.win.location.reload());
    for (const btn of this.card.querySelectorAll('.ot-mode-btn')) {
      btn.addEventListener('click', () => this.ctrl.setMode(btn.dataset.mode));
    }
    this.card.querySelector('.ot-switch-sel input').addEventListener('change', (e) => this.ctrl.toggleSel(e.target.checked));
    this.card.querySelector('.ot-switch-img input').addEventListener('change', (e) => this.ctrl.toggleImg(e.target.checked));
    this.card.querySelector('.ot-panel-settings').addEventListener('click', () => this.ctrl.openOptions());
    // 关闭入口：头部右侧的叉号，以及 Esc。球本身也能收起（见 mount），但面板铺开时用户第一反应
    // 是找叉号，而不是回去点那颗球。
    const closeBtn = this.card.querySelector('.ot-panel-close');
    if (closeBtn) {
      // 整条头部是拖拽把手，按在叉号上不应该开始拖动。
      closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      closeBtn.addEventListener('click', () => this._close());
    }
    this.doc.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.isOpen()) return;
        const target = e.target;
        if (target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        this._close();
      },
      true
    );
  }

  _renderFab() {
    if (!this.fab) return;
    const s = this.lastStatus;
    this.fab.classList.toggle('ot-on', !!s.enabled);
    const dot = this.fab.querySelector('.ot-fab-dot');
    if (dot) {
      dot.textContent = '';
      if (s.enabled) {
        dot.textContent = s.pending ? '…' : '✓';
        dot.title = s.pending ? `翻译中：队列 ${s.pending}，已完成 ${s.done}` : `已翻译 ${s.done} 段`;
      } else {
        dot.textContent = '';
        dot.title = '点击打开面板';
      }
    }
  }

  _renderCard() {
    if (!this.card) return;
    const s = this.lastStatus;
    const statusEl = this.card.querySelector('.ot-status');
    if (statusEl) {
      statusEl.textContent = s.enabled
        ? (s.pending ? `翻译中… 队列 ${s.pending} · 已完成 ${s.done}` : `✓ 已完成 ${s.done} 段${s.failed ? ` · ${s.failed} 段失败` : ''}`)
        : '未开启：点击上方按钮一键翻译（动态内容会自动补译）';
    }
    const tb = this.card.querySelector('.ot-btn-translate');
    if (tb) {
      tb.textContent = s.enabled ? '☰ 还原页面（回到原文）' : '☰ 一键翻译本页';
      tb.classList.toggle('ot-primary-on', !!s.enabled);
    }
    const mode = this.ctrl.getState ? this.ctrl.getState().mode : 'replace';
    for (const btn of this.card.querySelectorAll('.ot-mode-btn')) btn.classList.toggle('ot-active', btn.dataset.mode === mode);
    const st = this.ctrl.getState ? this.ctrl.getState() : {};
    const selChk = this.card.querySelector('.ot-switch-sel input');
    if (selChk && selChk.checked !== !!st.selTranslate) selChk.checked = !!st.selTranslate;
    const imgChk = this.card.querySelector('.ot-switch-img input');
    if (imgChk && imgChk.checked !== !!st.imgTranslate) imgChk.checked = !!st.imgTranslate;
  }
}
