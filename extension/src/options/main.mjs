// ============ 设置页（打包为 dist/options.js）：语言 / 引擎链 / 正文范围 / 句级重建 / OCR / 调试 ============
// 单一职责：把表单读成一份 settings 交给 saveSettings() 落盘；字段与默认值见 core/settings.mjs 的 DEFAULT_SETTINGS。
// 内容脚本每次翻译前都会重新 loadSettings()，所以改完设置保存即生效，不用重装扩展。
import { saveSettings, loadSettings, DEFAULT_SETTINGS, LANGS } from '../core/settings.mjs';

const $ = (s) => document.querySelector(s);
const targets = Object.keys(LANGS).filter((k) => LANGS[k].label);
function fillSelect(sel, values, selected) {
  sel.replaceChildren();   // 不用 innerHTML，保持「全仓不出现 innerHTML」
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = LANGS[v] ? LANGS[v].label : v;
    if (v === selected) o.selected = true;
    sel.append(o);
  }
}

let current = null;
async function load() {
  current = await loadSettings();
  fillSelect($('#targetLang'), targets, current.targetLang);
  fillSelect($('#sourceLang'), ['auto', ...targets], current.sourceLang);
  $('#selTranslate').checked = !!current.selTranslate;
  $('#imgTranslate').checked = !!current.imgTranslate;
  $('#translateUiLabels').checked = current.translateUiLabels !== false;
  $('#skipNoise').checked = current.skipNoise !== false;
  $('#headerIsContent').checked = current.headerIsContent !== false;
  $('#sentenceMerge').checked = current.sentenceMerge !== false;
  $('#concurrency').value = current.concurrency || 3;
  const jit = Array.isArray(current.requestJitterMs) ? current.requestJitterMs : [50, 200];
  $('#jitter').checked = (Number(jit[1]) || 0) > 0;
  $('#debug').checked = current.debug === true;
  document.querySelectorAll('.provider').forEach((c) => { c.checked = current.providerChain.includes(c.value); });
  const custom = current.customApi || {};
  $('#customEndpoint').value = custom.endpoint || '';
  $('#customKey').value = custom.apiKey || '';
  $('#customFormat').value = custom.format || 'json';
  $('#customModel').value = custom.model || '';
  syncCustomUI();
  $('#hostOverrides').value = JSON.stringify(current.hostOverrides || {}, null, 2);
  const coach = current.coach || {};
  $('#coachEnabled').checked = coach.enabled !== false;
  $('#coachToken').value = coach.token || '';
  $('#ocrMode').value = (current.ocr && current.ocr.mode) || 'tesseract';
  setOcrLang((current.ocr && current.ocr.lang) || 'eng');
}
function setOcrLang(v) {
  const sel = document.getElementById('ocrLang');
  if (!sel) return;
  const has = [...sel.options].some((o) => o.value === v);
  if (!has) { const o = document.createElement('option'); o.value = v; o.textContent = '自定义: ' + v; sel.append(o); }
  sel.value = v;
}
function syncCustomUI() {
  const chk = document.querySelector('.provider[value="custom"]');
  const on = !!(chk && chk.checked);
  const map = { customHint: 'block', customEndpointRow: 'flex', customKeyRow: 'flex', customFormatRow: 'flex' };
  for (const id of Object.keys(map)) {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? map[id] : 'none';
  }
}
document.querySelectorAll('.provider').forEach((c) => c.addEventListener('change', syncCustomUI));

$('#save').addEventListener('click', async () => {
  const chain = [...document.querySelectorAll('.provider')].filter((c) => c.checked).map((c) => c.value);
  if (!chain.length) { $('#msg').textContent = '至少选择一个引擎'; return; }
  let over = {};
  try { over = JSON.parse($('#hostOverrides').value || '{}'); } catch (_) { $('#msg').textContent = 'hostOverrides JSON 格式错误'; return; }
  const customOn = chain.includes('custom');
  const payload = {
    targetLang: $('#targetLang').value,
    sourceLang: $('#sourceLang').value,
    selTranslate: $('#selTranslate').checked,
    imgTranslate: $('#imgTranslate').checked,
    translateUiLabels: $('#translateUiLabels').checked,
    skipNoise: $('#skipNoise').checked,
    headerIsContent: $('#headerIsContent').checked,
    sentenceMerge: $('#sentenceMerge').checked,
    concurrency: Math.min(16, Math.max(1, +$('#concurrency').value || 3)),
    requestJitterMs: $('#jitter').checked ? [50, 200] : [0, 0],
    debug: !!$('#debug').checked,
    providerChain: chain,
    hostOverrides: over,
    ocr: { enabled: true, mode: $('#ocrMode').value, lang: $('#ocrLang').value || 'eng' },
    coach: { enabled: $('#coachEnabled').checked, token: $('#coachToken').value.trim(), port: 0 },
    customApi: customOn ? { endpoint: $('#customEndpoint').value.trim(), apiKey: $('#customKey').value.trim(), format: $('#customFormat').value, model: $('#customModel').value.trim() } : {}
  };
  await saveSettings(payload);
  $('#msg').textContent = '✓ 已保存（已开启翻译的页面会自动刷新生效）';
});

$('#test').addEventListener('click', async () => {
  $('#msg').textContent = '测试中…';
  const s = await loadSettings();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ot-test', settings: s });
    $('#msg').textContent = res && res.ok ? '✓ 引擎可用：' + res.text : '✗ ' + (res && res.error || '失败');
  } catch (e) { $('#msg').textContent = '✗ ' + (e && e.message); }
});

// 「连接」：先把表单里的口令存下去，再让 SW 去探桌面端 + 校验口令。
$('#coachConnect').addEventListener('click', async () => {
  const token = $('#coachToken').value.trim();
  // 复用上次记住的端口：SW 先探这个已知端口，探不通再全量扫一遍；没记住就传 0。
  const known = current && current.coach ? Number(current.coach.port) : 0;
  const port = Number.isInteger(known) && known > 0 ? known : 0;
  try {
    await saveSettings({ coach: { enabled: $('#coachEnabled').checked, token, port } });
    $('#coachMsg').textContent = '检测中…';
    const res = await chrome.runtime.sendMessage({ type: 'ot-bridge-pair', token, port });
    if (res && res.ok) {
      $('#coachMsg').textContent = '✓ 已连接（端口 ' + res.port + '，协议 v' + res.protocol + '）';
    } else {
      $('#coachMsg').textContent = '✗ ' + ((res && res.message) || '连接失败');
    }
  } catch (e) {
    $('#coachMsg').textContent = '✗ ' + ((e && e.message) || e);
  }
});

$('#reset').addEventListener('click', async () => {
  await saveSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  await load();
  $('#msg').textContent = '已恢复默认';
});

load();
