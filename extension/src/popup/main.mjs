// ============ 工具栏弹窗（打包为 dist/popup.js）：整页翻译开关 + 模式 + 划词/图片开关 + 引擎自测 ============
// 单一职责：读设置、写设置、给当前 tab 的内容脚本发 cmd 消息。
// 真正的翻译逻辑在 src/core/，弹窗关掉不影响已经开始的翻译。
import { saveSettings, loadSettings } from '../core/settings.mjs';

const $ = (s) => document.querySelector(s);

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let state = null;
async function refresh() {
  const s = await loadSettings();
  state = s;
  $('#segMode button[data-mode="' + (s.mode || 'replace') + '"]').classList.add('on');
  $('#chkSel').checked = !!s.selTranslate;
  $('#chkImg').checked = !!s.imgTranslate;
  const tab = await currentTab();
  if (!tab || tab.id == null || !/^https?:/.test(tab.url || '')) {
    $('#btnToggle').disabled = true;
    $('#status').textContent = '当前页面不是 http/https 网页';
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-get-state' });
    if (res && res.ok) {
      state = res.state;
      $('#btnToggle').classList.toggle('on', !!res.state.enabled);
      $('#btnToggle').textContent = res.state.enabled ? '☰ 还原页面（回到原文）' : '☰ 一键翻译本页';
      const st = res.state.status || {};
      $('#status').textContent = res.state.enabled
        ? (st.pending ? `翻译中… 队列 ${st.pending}，已完成 ${st.done}` : `已翻译 ${st.done} 段`)
        : '就绪（点击按钮整页翻译，滚动加载会自动补译）';
    } else {
      $('#status').textContent = '就绪（点击按钮整页翻译）';
    }
  } catch (_) {
    $('#status').textContent = '就绪（点击按钮整页翻译）';
  }
}

$('#btnToggle').addEventListener('click', async () => {
  const tab = await currentTab();
  if (!tab || tab.id == null) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-toggle-page' });
    if (res && res.ok) {
      state = res.state;
      $('#btnToggle').classList.toggle('on', !!state.enabled);
      $('#btnToggle').textContent = state.enabled ? '☰ 还原页面（回到原文）' : '☰ 一键翻译本页';
    }
  } catch (_) {}
  refresh();
});

for (const b of document.querySelectorAll('#segMode button')) {
  b.addEventListener('click', async () => {
    const tab = await currentTab();
    document.querySelectorAll('#segMode button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    await saveSettings({ mode: b.dataset.mode });
    if (tab && tab.id != null) {
      try { await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-set-mode', mode: b.dataset.mode }); } catch (_) {}
    }
  });
}
$('#chkSel').addEventListener('change', async () => {
  await saveSettings({ selTranslate: $('#chkSel').checked });
  const tab = await currentTab();
  if (tab && tab.id != null) { try { await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-set-sel', value: $('#chkSel').checked }); } catch (_) {} }
});
$('#chkImg').addEventListener('change', async () => {
  await saveSettings({ imgTranslate: $('#chkImg').checked });
  const tab = await currentTab();
  if (tab && tab.id != null) { try { await chrome.tabs.sendMessage(tab.id, { cmd: 'ot-set-img', value: $('#chkImg').checked }); } catch (_) {} }
});
// ---------- AI Language Coach：在弹窗里就地粘贴口令并连接 ----------
// 用户最快能找到口令框的地方就是这里：桌面端点「复制口令」之后，不必再翻到扩展设置页。
const coachMsgEl = $('#coachMsg');
function coachSay(text, kind) {
  coachMsgEl.textContent = text;
  coachMsgEl.className = kind ? 'hint coach-' + kind : 'hint';
}
function coachDot(on) { $('#coachDot').classList.toggle('on', on === true); }
function coachPort(settings) {
  const port = Number(settings && settings.coach && settings.coach.port);
  return Number.isInteger(port) && port > 0 ? port : 0;
}

async function refreshCoach() {
  const settings = await loadSettings();
  const coach = settings.coach || {};
  $('#coachEnabled').checked = coach.enabled !== false;
  if ($('#coachToken').value === '') $('#coachToken').value = coach.token || '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ot-bridge-status' });
    if (res && res.ok && res.listening) {
      coachDot(res.paired === true);
      coachSay(res.message || '', res.paired === true ? 'ok' : 'warn');
    } else {
      coachDot(false);
      coachSay((res && res.message) || '未检测到桌面端', 'warn');
    }
  } catch (e) {
    coachDot(false);
    coachSay(String((e && e.message) || e), 'warn');
  }
}

async function connectCoach() {
  const token = $('#coachToken').value.trim();
  if (!token) {
    coachSay('口令是空的：先在桌面端点「复制口令」，再回到这里按 Ctrl+V', 'warn');
    $('#coachToken').focus();
    return;
  }
  $('#coachConnect').disabled = true;
  coachDot(false);
  coachSay('检测中…');
  try {
    const port = coachPort(await loadSettings());
    await saveSettings({ coach: { enabled: $('#coachEnabled').checked, token, port } });
    const res = await chrome.runtime.sendMessage({ type: 'ot-bridge-pair', token, port });
    if (res && res.ok) {
      coachDot(true);
      coachSay('✓ 已连接（端口 ' + res.port + '，协议 v' + res.protocol + '）', 'ok');
    } else {
      coachSay('✗ ' + ((res && res.message) || '连接失败'), 'warn');
    }
  } catch (e) {
    coachSay('✗ ' + ((e && e.message) || e), 'warn');
  } finally {
    $('#coachConnect').disabled = false;
  }
}

$('#coachPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const token = (text || '').trim();
    if (!token) { coachSay('剪贴板是空的：先在桌面端点「复制口令」', 'warn'); return; }
    $('#coachToken').value = token;
    coachSay('已读到剪贴板，点「连接」完成配对');
  } catch (_e) {
    $('#coachToken').focus();
    coachSay('浏览器不允许直接读剪贴板：请在框里按 Ctrl+V 粘贴', 'warn');
  }
});
$('#coachConnect').addEventListener('click', () => { void connectCoach(); });
$('#coachEnabled').addEventListener('change', async () => {
  const port = coachPort(await loadSettings());
  await saveSettings({ coach: { enabled: $('#coachEnabled').checked, token: $('#coachToken').value.trim(), port } });
});
refreshCoach();
$('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#btnTest').addEventListener('click', async () => {
  $('#status').textContent = '引擎测试中（约几秒）…';
  const s = await loadSettings();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ot-test', settings: s });
    if (res && res.ok) $('#status').textContent = '✓ 引擎可用：' + res.text;
    else $('#status').textContent = '✗ 引擎失败：' + (res && res.error || 'unknown');
  } catch (e) { $('#status').textContent = '✗ ' + (e && e.message); }
});

refresh();
