// ============ OmniTranslate 后台 Service Worker ============
// 职责（不含任何翻译算法，算法全在 src/core/）：
//   1) 设置落盘：安装时写入 DEFAULT_SETTINGS，供内容脚本/设置页 loadSettings() 读取；
//   2) 快捷键与右键菜单：Alt+T 整页翻译、Alt+Shift+S 划词浮层开关、图片右键「翻译此图片」；
//   3) 帧同步：activePageTabs 记录某 tab 是否正在整页翻译，供 iframe 询问（ot-frame-query）与广播（ot-frame-set）；
//   4) 跨域取图：ot-fetch-image 在后台把图片取成 base64，绕开页面侧的 CORS 限制；
//   5) 离线 OCR 调度：ot-ocr 转交离屏文档（dist/offscreen.html + vendor/tesseract/）；
//   6) 引擎自测：ot-test 用当前设置真实请求一次翻译引擎（弹窗/设置页的「测试引擎」）。
// 注意：MV3 的 Service Worker 随时会被休眠回收，activePageTabs 这类内存态会随之丢失（页面下次切换翻译时再同步一次）。
import { DEFAULT_SETTINGS } from '../core/settings.mjs';
import { TranslateEngine } from '../core/engines.mjs';
import { BRIDGE_PREWAKE_PROBE_TIMEOUT_MS, BRIDGE_WAKE_TIMEOUT_MS, bridgeErrorMessage, ensurePort, learnFromPage, makeRequestId, pairBridge, sanitizeCoach } from '../core/bridge.mjs';

const SETTINGS_KEY = 'ot-settings-v1';

// tabId -> 整页翻译是否开启（顶层广播到各 iframe 用）
const activePageTabs = new Map();
chrome.tabs.onRemoved.addListener((tabId) => { activePageTabs.delete(tabId); });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY).then((got) => {
    if (!got || !got[SETTINGS_KEY]) {
      chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    }
  }).catch(() => {});
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'ot-translate-image',
        title: '翻译此图片（万译）',
        contexts: ['image']
      });
      // 右键菜单是「学习这句」最容易发现的那条路：不用先知道要按住 Ctrl+Shift 划词。
      chrome.contextMenus.create({
        id: 'ot-learn-selection',
        title: '发送到 AI Language Coach（学习这句）',
        contexts: ['selection']
      });
    });
  } catch (_) {}
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ot-translate-image' && tab && tab.id != null && info.srcUrl) {
    sendToTab(tab.id, { cmd: 'ot-translate-image-url', url: info.srcUrl }, { frameId: (info.frameId || 0) });
  }
  if (info.menuItemId === 'ot-learn-selection' && tab && tab.id != null) {
    learnSelectionFromMenu(info, tab);
  }
});

// 把右键选中的那句话交给桌面端 Learn。
//
// 优先让内容脚本去做：它能在页面上给一条回执（正在发送 / 已学习 / 为什么失败），
// 而 SW 里的失败是看不见的。内容脚本不在（扩展刚装上、这个 tab 还没重新加载）时，
// 退回 SW 直接发送：句子照样能学进去，只是页面上没有回执 —— 桌面端那边仍然会跳出来。
async function learnSelectionFromMenu(info, tab) {
  const text = typeof info.selectionText === 'string' ? info.selectionText : '';
  if (!text.trim()) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-learn-selection', text }, { frameId: info.frameId || 0 });
    // 内容脚本给了答案（成功或失败）就是答案：它已经在页面上说清楚了。再让 SW 发一次，
    // 只会往桌面端多写一条 —— 两次的 requestId 不同，服务端的幂等窗口是兜不住它的。
    if (res && res.error !== 'not ready') return;
  } catch (_e) { /* 内容脚本不在（扩展刚装上 / 这个 tab 还没重载）：落到下面 */ }
  try {
    await coachLearn({ text, url: tab.url || '', title: tab.title || '' });
  } catch (_e) { /* 桌面端没开：没有地方可以报，和浮层按钮的静默失败一致 */ }
}

// 键盘快捷键
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-page-translate' && command !== 'toggle-sel-mode') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab || tab.id == null) return;
    if (command === 'toggle-page-translate') {
      sendToTab(tab.id, { cmd: 'ot-toggle-page' });
    } else {
      // 在内容页读取当前状态再翻转（通过 toggle-page 的兄弟消息简化为直接切换）
      chrome.tabs.sendMessage(tab.id, { cmd: 'ot-get-state' }, { frameId: 0 }).then((res) => {
        const cur = !!(res && res.state && res.state.selTranslate);
        sendToTab(tab.id, { cmd: 'ot-set-sel', value: !cur });
      }).catch(() => {});
    }
  }).catch(() => {});
});

async function sendToTab(tabId, msg, opts) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, msg, opts || { frameId: 0 });
    if (resp && resp.state && resp.state.enabled && resp.state.enabled === true) {
      chrome.action.setBadgeText({ tabId, text: '译' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563EB' });
    } else if (resp && resp.state) {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (_) {
    // 内容脚本尚未注入：先注入再重试一次（定向到原目标 frame）
    try {
      const frameId = (opts && opts.frameId) || 0;
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['dist/content.js'] });
      await new Promise((r) => setTimeout(r, 150));
      const resp = await chrome.tabs.sendMessage(tabId, msg, { frameId });
      if (resp && resp.state) {
        chrome.action.setBadgeText({ tabId, text: resp.state.enabled ? '译' : '' });
      }
    } catch (e) { console.warn('[ot] tab messaging failed', e); }
  }
}

// ---------- 通用消息：图片读取 / OCR 调度 ----------
let offscreenBusy = null;

async function ensureOffscreen() {
  if (!offscreenBusy) {
    offscreenBusy = (async () => {
      if (typeof chrome.offscreen === 'undefined') throw new Error('offscreen unsupported');
      try { if (await chrome.offscreen.hasDocument()) return; } catch (_) {}
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('dist/offscreen.html'),
        reasons: ['BLOBS', 'CLIPBOARD'],
        justification: 'OCR 识别并翻译图片文字'
      });
    })().finally(() => { offscreenBusy = null; });
  }
  return offscreenBusy;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !msg.type) return;

  if (msg.type === 'ot-fetch-image') {
    fetchImageToBase64(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'ot-ocr') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage(msg))
      .then((res) => sendResponse(res || { ok: false, error: 'no response' }))
      .catch((e) => sendResponse({ ok: false, error: 'offscreen: ' + (e && e.message) }));
    return true;
  }
  if (msg.type === 'ot-frame-query') {
    const tabId = sender.tab && sender.tab.id;
    sendResponse({ ok: true, enabled: !!(tabId != null && activePageTabs.get(tabId)) });
    return;
  }
  if (msg.type === 'ot-frame-set') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      activePageTabs.set(tabId, !!msg.enabled);
      chrome.tabs.sendMessage(tabId, { cmd: 'ot-frame-state', enabled: !!msg.enabled }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'ot-bridge-status') {
    bridgeStatus().then(sendResponse).catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'ot-bridge-pair') {
    bridgePair(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'ot-learn-sentence') {
    coachLearn(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: 'internal', message: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'ot-test') {
    const st = msg.settings || {};
    const over = st.hostOverrides || {};
    const baseUrls = { google: 'https://translate.googleapis.com', edge: 'https://edge.microsoft.com' };
    if (over.google) baseUrls.google = over.google;
    if (over.edge) baseUrls.edge = over.edge;
    if (over.mock) baseUrls.mock = over.mock;
    const eng = new TranslateEngine({
      providerChain: (st.providerChain && st.providerChain.length) ? st.providerChain : ['google', 'edge'],
      sourceLang: st.sourceLang || 'auto',
      targetLang: st.targetLang || 'zh-CN',
      baseUrls,
      customApi: st.customApi || {}
    });
    eng.translateMany(['Hello world, welcome to OmniTranslate.']).then(({ ok }) => {
      const v = ok.get('Hello world, welcome to OmniTranslate.');
      sendResponse(v ? { ok: true, text: v } : { ok: false, error: 'empty result' });
    }).catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  return undefined;
});

// ---------- AI Language Coach 桥接（网页 → 本机桌面端） ----------
// 请求一律在这里发，不在内容脚本里发：内容脚本受页面 CSP（connect-src）约束，
// 而且页面一跳转就被销毁；SW 有 host_permissions，也不会因为换页丢状态。
// 这里只做「读设置 → 找端口 → 转发」，协议本身在 core/bridge.mjs（可单测）。

// 不用 settings.mjs 的 loadSettings()：它在 SW 里会被 memo 住，
// 而设置页改完口令后 SW 可能还拿着旧值——桥接最怕用旧口令。这里直接读 storage。
async function readCoach() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = got && got[SETTINGS_KEY];
    return sanitizeCoach(raw ? raw.coach : DEFAULT_SETTINGS.coach);
  } catch (_e) {
    return sanitizeCoach(DEFAULT_SETTINGS.coach);
  }
}

// 只改 coach 一个字段：先读回整份设置再写。直接 saveSettings() 会把 SW 里过期的
// memo 整份写回，把用户在设置页改过的其它项覆盖掉。
async function writeCoach(next) {
  let current = null;
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    current = got && got[SETTINGS_KEY];
  } catch (_e) { current = null; }
  const merged = { ...(current && typeof current === 'object' ? current : {}), coach: next };
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  } catch (_e) { /* 写不进去也不该让学习失败 */ }
  return merged;
}

async function rememberPort(coach, port) {
  if (!port || port === coach.port) return;
  await writeCoach({ ...coach, port });
}

async function bridgeStatus() {
  const coach = await readCoach();
  if (!coach.enabled) return { ok: true, listening: false, paired: false, port: null, message: '浏览器连接已关闭' };
  const found = await ensurePort(coach);
  if (!found.listening) return { ok: true, listening: false, paired: false, port: null, message: '未检测到桌面端，请先启动 AI Language Coach' };
  await rememberPort(coach, found.port);
  if (!coach.token) return { ok: true, listening: true, paired: false, port: found.port, protocol: found.protocol, message: '已检测到桌面端，但还没有配对' };
  const paired = await pairBridge({ token: coach.token, port: found.port });
  return {
    ok: true,
    listening: true,
    paired: !!paired.ok,
    port: found.port,
    protocol: found.protocol,
    message: paired.ok ? '已连接' : (paired.message || bridgeErrorMessage('unauthorized'))
  };
}

async function bridgePair(msg) {
  const saved = await readCoach();
  const coach = sanitizeCoach({ ...saved, token: msg && msg.token, port: msg && msg.port });
  if (!coach.enabled) return { ok: false, message: '浏览器连接已关闭，请先勾选开启。' };
  if (!coach.token) return { ok: false, message: '请先填写桌面端的连接口令。' };
  const found = await ensurePort(coach);
  if (!found.listening) return { ok: false, message: '未检测到桌面端，请先启动 AI Language Coach。' };
  const paired = await pairBridge({ token: coach.token, port: found.port });
  if (!paired.ok) return { ok: false, port: found.port, message: paired.message };
  await writeCoach({ ...coach, port: found.port });
  return { ok: true, port: found.port, protocol: paired.protocol, message: '已连接' };
}

// 同一 requestId 只跑一次。内容脚本在「点门铃之前」和「点完门铃之后」各发一次同一个 requestId：
// 桌面端用 60 秒幂等窗口兜住服务端，这里兜住客户端——重复的那次直接复用第一次的结果，不重复发。
const coachInFlight = new Map();

async function coachLearn(msg) {
  const requestId = typeof msg.requestId === 'string' && msg.requestId ? msg.requestId : makeRequestId();
  const existing = coachInFlight.get(requestId);
  if (existing) return existing;
  const run = coachLearnOnce(msg, requestId).finally(() => coachInFlight.delete(requestId));
  coachInFlight.set(requestId, run);
  return run;
}

async function coachLearnOnce(msg, requestId) {
  const coach = await readCoach();
  // 第一次只做一次快速探测（prewake）：这一刻还在用户点击的手势窗口里，探测必须快，
  // 否则浏览器会以「没有用户手势」为由拒绝唤起 ctoe://。
  const found = await ensurePort(coach, msg.prewake === true ? { timeoutMs: BRIDGE_PREWAKE_PROBE_TIMEOUT_MS } : {});
  if (found.listening) await rememberPort(coach, found.port);
  // 内容脚本点完门铃后会带 waitForMs 再来一次：门铃已经点过了，SW 里没有 DOM、也不该再点，
  // 只要等端口出现。上限取客户端常量，别让一条消息让 SW 干等太久。
  const waitForMs = Math.max(0, Math.min(Number(msg.waitForMs) || 0, BRIDGE_WAKE_TIMEOUT_MS));
  return learnFromPage(
    found.listening ? { ...coach, port: found.port } : { ...coach, port: 0 },
    { text: msg.text, mode: msg.mode, langHint: msg.langHint, url: msg.url, title: msg.title, requestId },
    waitForMs > 0 ? { waitForMs } : {}
  );
}

async function fetchImageToBase64(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const blob = await res.blob();
    if (blob.size > 25 * 1024 * 1024) return { ok: false, error: 'image too large' };
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return { ok: true, base64: btoa(bin), mime: blob.type || '' };
  } catch (e) {
    return { ok: false, error: 'fetch fail ' + (e && e.message) };
  }
}
