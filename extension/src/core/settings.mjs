// ---------- OmniTranslate settings & constants ----------

import { sanitizeCoach } from './bridge.mjs';

export const EXT_NAME = 'OmniTranslate';
export const DEFAULT_SETTINGS = Object.freeze({
  targetLang: 'zh-CN',           // 目标语言
  sourceLang: 'auto',            // 源语言 auto / en ...
  enabled: false,                // 整页翻译开关（per-tab 记忆在 content）
  mode: 'replace',               // replace: 仅译文; bilingual: 双语对照
  selTranslate: true,            // 划词翻译
  selPopupPinned: false,         // 固定小卡
  imgTranslate: false,           // 图片翻译模式（点图翻译）
  providerChain: ['google', 'edge'],  // 依次降级
  concurrency: 3,                // 全局并发上限（请求队列，防止风控）
  requestJitterMs: [50, 200],    // 请求间随机抖动（ms）；[0,0] 关闭
  retry: 2,
  skipNoise: true,               // 只译正文：跳过 header/nav/footer/aside/广告/Cookie 条等非正文区域
  headerIsContent: true,         // 页头里含 h1/h2 且不含 nav 时按正文翻译（站点顶栏仍跳过）
  sentenceMerge: true,           // 句级重建：把被行内标签切开的同一句话合并成一个单元翻译
  translateUiLabels: false,      // 是否翻译按钮/导航等 UI 文案（默认跳过 <button>，只译正文）
  translateAttributes: false,    // 保留位：本插件只改文本节点，不翻译任何属性
  translateImages: false,        // 若图内文字可被直接读取(alt)也作为文本
  debug: false,                  // 调试日志（扫描节点数/缓存命中/耗时等）
  ocr: { enabled: true, lang: 'eng', minConfidence: 60 },
  hostOverrides: {},             // { google: 'http://...', edge: '...' } 测试/代理用
  ui: { fontSize: 'auto', showStatus: true, statusPos: 'br' },
  coach: { enabled: true, token: '', port: 0 }
});

export const LANGS = Object.freeze({
  'zh-CN': { label: '简体中文', family: 'zh', scripts: ['han'], css: 'zh-CN' },
  'zh-TW': { label: '繁體中文', family: 'zh', scripts: ['han'], css: 'zh-TW' },
  en: { label: 'English', family: 'en', scripts: ['latin'], css: 'en' },
  ja: { label: '日本語', family: 'ja', scripts: ['kana', 'han'], css: 'ja' },
  ko: { label: '한국어', family: 'ko', scripts: ['hangul'], css: 'ko' },
  fr: { label: 'Français', family: 'fr', scripts: ['latin'], css: 'fr' },
  de: { label: 'Deutsch', family: 'de', scripts: ['latin'], css: 'de' },
  es: { label: 'Español', family: 'es', scripts: ['latin'], css: 'es' },
  ru: { label: 'Русский', family: 'ru', scripts: ['cyrillic'], css: 'ru' },
  pt: { label: 'Português', family: 'pt', scripts: ['latin'], css: 'pt' },
  it: { label: 'Italiano', family: 'it', scripts: ['latin'], css: 'it' }
});

export const STORAGE_KEYS = {
  settings: 'ot-settings-v1',
  cache: 'ot-cache-v3',
  pageState: 'ot-page-state-v1'
};

export const PROVIDER_LABELS = Object.freeze({
  google: 'Google（免费端点）',
  edge: 'Microsoft Edge（免费）',
  custom: '自定义 API',
  mock: '本地 Mock（测试）'
});

const NUMERIC = /^\s*[\d\s.,%$€£¥+()\-/x*°·:;]+\s*$/;

export function sanitizeSettings(raw = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const out = { ...base, ...raw };
  if (!LANGS[out.targetLang]) out.targetLang = 'zh-CN';
  if (!Array.isArray(out.providerChain) || !out.providerChain.length) out.providerChain = ['google', 'edge'];
  out.providerChain = out.providerChain.filter((p) => PROVIDER_LABELS[p] || p === 'custom' || p === 'mock');
  out.hostOverrides = out.hostOverrides && typeof out.hostOverrides === 'object' ? out.hostOverrides : {};
  out.concurrency = Math.min(16, Math.max(1, Number(out.concurrency) || 3));
  out.retry = Math.min(5, Math.max(0, Number(out.retry) || 2));
  const j = out.requestJitterMs;
  if (Array.isArray(j)) {
    const lo = Math.min(2000, Math.max(0, Number(j[0]) || 0));
    const hi = Math.min(3000, Math.max(lo, Number(j[1]) || lo));
    out.requestJitterMs = [lo, hi];
  } else {
    const v = Math.min(3000, Math.max(0, Number(j) || 0));
    out.requestJitterMs = [v, v];
  }
  out.translateUiLabels = out.translateUiLabels === true;
  out.skipNoise = out.skipNoise !== false;
  out.headerIsContent = out.headerIsContent !== false;
  out.sentenceMerge = out.sentenceMerge !== false;
  out.debug = out.debug === true;
  out.coach = sanitizeCoach(out.coach);
  return out;
}

let memorySettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let settingsPromise = null;

export function setMemorySettings(s) { memorySettings = sanitizeSettings(s); }

export function getSettings() { return memorySettings; }

export async function loadSettings() {
  if (!settingsPromise) {
    settingsPromise = (async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const got = await chrome.storage.local.get(STORAGE_KEYS.settings);
          if (got && got[STORAGE_KEYS.settings]) {
            memorySettings = sanitizeSettings(got[STORAGE_KEYS.settings]);
          }
        }
      } catch (_e) { /* keep memory */ }
      return memorySettings;
    })();
  }
  return settingsPromise;
}

export async function saveSettings(partial) {
  memorySettings = sanitizeSettings({ ...memorySettings, ...partial });
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: memorySettings });
    } catch (_e) { /* ignore */ }
  }
  return memorySettings;
}
