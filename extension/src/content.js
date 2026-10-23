// ============ OmniTranslate 内容脚本入口（esbuild 打包为 IIFE） ============
import { loadSettings, saveSettings, sanitizeSettings, getSettings } from './core/settings.mjs';
import { PageTranslator } from './core/translator.mjs';
import { SelectionTranslator } from './core/selection.mjs';
import { ImageTranslator } from './core/image.mjs';
import { Panel } from './core/panel.mjs';

// 内容脚本入口（每个 frame 各跑一份，esbuild 打包为 IIFE = dist/content.js）：
//   boot() 依次装配 PageTranslator（整页翻译状态机）→ Panel（仅顶层：悬浮球 + 控制卡）
//   → SelectionTranslator（划词浮层）→ ImageTranslator（点图 OCR）→ bindMessages（与 SW / 弹窗的消息路由）。
//   iframe 内只做文本翻译、不挂悬浮 UI：由 SW 的 ot-frame-set 广播开启，或在加载时用 ot-frame-query 询问后自启。
const doc = document;
const win = window;

// 是否顶层窗口：iframe 只做文本翻译，不挂悬浮 UI
const isTopFrame = (function () {
  try { return win === win.top; } catch (_) { return false; }
})();

let settings = sanitizeSettings(getSettings());
let translator = null;
let selection = null;
let imgT = null;
let panel = null;
let status = { phase: 'idle', enabled: false, pending: 0, done: 0, failed: 0 };

async function boot() {
  settings = sanitizeSettings(await loadSettings());

  // 调试状态：内容脚本运行在隔离世界，页面主世界（F12 默认上下文）读不到 win.__otDebug，
  // 所以同时把同一份状态镜像到 <html data-ot-debug="...">（JSON），任何 frame 都能直接读
  let lastDebugKey = '';
  const publishDebug = () => {
    const dbg = {
      frame: isTopFrame ? 'top' : 'child',
      phase: status.phase, enabled: status.enabled, pending: status.pending,
      done: status.done, failed: status.failed, lastScan: status.lastScan,
      mode: translator ? translator.mode : '',
      strategy: translator ? translator.strategy : '',
      chain: (translator && translator.engine && translator.engine.chain) || [],
      shadowRoots: status.shadowRoots || 0,
      stats: status.stats || null
    };
    const now = Date.now();
    try { win.__otDebug = { ...dbg, ts: now }; } catch (_) {}
    const key = JSON.stringify(dbg);
    if (key === lastDebugKey) return; // 状态未变则不写 DOM，避免无谓的属性变更
    lastDebugKey = key;
    try { doc.documentElement.setAttribute('data-ot-debug', JSON.stringify({ ...dbg, ts: now })); } catch (_) {}
  };

  const onStatus = (s) => {
    status = { ...status, ...s };
    publishDebug();
    if (panel) panel.updateStatus(status);
  };

  translator = new PageTranslator({ doc, win, settings, onStatus });
  await translator.init();

  const controller = {
    getState() { return { enabled: translator.isEnabled, mode: translator.mode, selTranslate: selection ? selection.enabled : settings.selTranslate, imgTranslate: imgT ? imgT.enabled : settings.imgTranslate, status }; },
    async togglePage() {
      settings = sanitizeSettings(await loadSettings());
      if (translator.isEnabled) {
        translator.setEnabled(false);
      } else {
        applyEngineSettings();
        translator.setEnabled(true);
      }
      syncFramesEnabled(translator.isEnabled);
    },
    async setMode(mode) {
      if (mode === translator.mode) return;
      settings = sanitizeSettings(await saveSettings({ mode }));
      // 「仅译文 / 双语对照」都只改文本节点与属性（不新建节点、不刷新页面），可以随时切换
      translator.setMode(mode);
    },
    async toggleSel(v) {
      settings = sanitizeSettings(await saveSettings({ selTranslate: !!v }));
      if (selection) selection.setEnabled(!!v);
    },
    async toggleImg(v) {
      settings = sanitizeSettings(await saveSettings({ imgTranslate: !!v }));
      if (imgT) imgT.setEnabled(!!v);
    },
    openOptions() {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    }
  };
  if (isTopFrame) {
    panel = new Panel({ doc, win, controller });
    panel.mount();
    // 顶层每次加载先把该 tab 的帧翻译状态复位为关闭（页面 reload 后默认原文优先）
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const p0 = chrome.runtime.sendMessage({ type: 'ot-frame-set', enabled: false });
        if (p0 && typeof p0.catch === 'function') p0.catch(() => {});
      }
    } catch (_) {}
  }

  selection = new SelectionTranslator({ doc, win, translator, settings });
  selection.enabled = settings.selTranslate;
  selection.pinned = settings.selPopupPinned;
  selection.start();

  imgT = new ImageTranslator({ doc, win, translator, settings });
  imgT.start();

  bindMessages(controller);

  // 非顶层 frame：若顶层已开启整页翻译（正文可能在 iframe 里），同步开启本 frame 翻译
  if (!isTopFrame && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    setTimeout(() => {
      try {
        Promise.resolve(chrome.runtime.sendMessage({ type: 'ot-frame-query' }))
          .then((res) => {
            if (res && res.ok && res.enabled && translator && !translator.isEnabled) {
              applyEngineSettings();
              translator.setEnabled(true);
            }
          })
          .catch(() => {});
      } catch (_) {}
    }, 500);
  }

  // 存储变化（选项页修改）即时同步
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes['ot-settings-v1'] && changes['ot-settings-v1'].newValue) {
        const next = sanitizeSettings(changes['ot-settings-v1'].newValue);
        const liveFields = ['selTranslate', 'imgTranslate'];
        let needRestart = false;
        for (const k of Object.keys(settings)) {
          if (!liveFields.includes(k) && JSON.stringify(next[k]) !== JSON.stringify(settings[k])) needRestart = true;
        }
        settings = next;
        applyEngineSettings();
        if (needRestart && translator.isEnabled) {
          // 设置变化要重新翻译：先逐节点还原原文，再按新设置跑一遍（全程只改文本节点，不刷新页面）
          translator.setEnabled(false);
          translator.setEnabled(true);
        }
      }
    });
  }

  // 已开启状态下刷新恢复（页面 reload 后默认关闭，保证原文优先）
  // 标记本轮翻译状态，供 popup 展示
  if (isTopFrame) document.documentElement.setAttribute('data-ot-loaded', '1');
  publishDebug(); // 每个 frame（含 iframe）都先镜像一份初始状态，便于排查"能划词不能整页"这类问题
}

// 引擎 / 语言设置应用到翻译器（顶层声明：boot() 与 bindMessages() 的 iframe 同步都要用）
function applyEngineSettings() {
  if (!translator) return;
  // 引擎参数（语言/引擎链/并发/抖动）与派生规则（跳过 <button> 等）一起热更新
  translator.applySettings(settings);
}

function syncFramesEnabled(enabled) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const p = chrome.runtime.sendMessage({ type: 'ot-frame-set', enabled: !!enabled });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_) {}
}

function bindMessages(controller) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

  // 兜底：换路径重新加载扩展后，Chrome 有时不会真正分配 manifest 里的 suggested_key，
  // chrome.commands 永远不触发，Alt+T 就「坏掉」了。页面自己认一次这个组合键，翻译照样能用。
  // 命令正常时 Chrome 会吃掉这次按键，页面收不到，所以两条路不会互相抢。
  doc.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code !== 'KeyT' && String(event.key).toLowerCase() !== 't') return;
    event.preventDefault();
    try {
      const pending = chrome.runtime.sendMessage({ type: 'ot-toggle-page-hotkey' });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_e) { /* 扩展上下文已失效（页面还是旧的），刷新一次页面即可恢复 */ }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.cmd === 'ot-frame-state') {
      // 顶层已开启/关闭整页翻译：同步本 frame 的文本翻译
      if (!isTopFrame && typeof msg.enabled === 'boolean' && translator) {
        try {
          if (msg.enabled && !translator.isEnabled) { applyEngineSettings(); translator.setEnabled(true); }
          else if (!msg.enabled && translator.isEnabled) translator.setEnabled(false);
        } catch (e) { console.warn('[ot] frame translate failed', e); }
      }
      return;
    }
    const topOnly = msg.cmd === 'ot-get-state' || msg.cmd === 'ot-toggle-page' || msg.cmd === 'ot-set-sel' || msg.cmd === 'ot-set-img' || msg.cmd === 'ot-set-mode';
    if (!isTopFrame && topOnly) return;
    switch (msg.cmd) {
      case 'ot-get-state':
        sendResponse({ ok: true, state: controller.getState() });
        return;
      case 'ot-toggle-page':
        controller.togglePage().then(() => sendResponse({ ok: true, state: controller.getState() })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      case 'ot-set-sel':
        controller.toggleSel(!!msg.value).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
      case 'ot-set-img':
        controller.toggleImg(!!msg.value).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
      case 'ot-set-mode':
        controller.setMode(String(msg.mode || 'replace')).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
      case 'ot-translate-image-url': {
        if (!imgT) { sendResponse({ ok: false, error: 'not ready' }); return; }
        findAndTranslateImage(msg.url).then((ok) => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      case 'ot-learn-selection': {
        // 右键菜单进来的那句话：交给同一个 SelectionTranslator，它负责发送并在页面上给回执。
        if (!selection) { sendResponse({ ok: false, error: 'not ready' }); return; }
        selection.learnFromMenu(msg.text)
          .then((r) => sendResponse({ ok: !!(r && r.ok), message: (r && r.message) || '' }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      default:
        return;
    }
  });

  async function findAndTranslateImage(url) {
    const target = url && decodeURIComponent(url);
    const imgs = [...doc.querySelectorAll('img')];
    const img = imgs.find((i) => (i.currentSrc || i.src) && decodeURIComponent(i.currentSrc || i.src) === target) || imgs.find((i) => (i.src || '').split('?')[0] === (target || '').split('?')[0]);
    if (!img) {
      imgT.showTip ? imgT.showTip('未在页面中找到该图片，请等待加载后重试') : alert('未在页面中找到该图片。');
      return false;
    }
    // 菜单触发：允许即使未开启图片模式
    const prev = imgT.enabled;
    imgT.enabled = false;
    await imgT._begin(img, img.currentSrc || img.src);
    imgT.enabled = prev;
    return true;
  }
}

boot();
