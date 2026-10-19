// ---------- 规则层：标签 / 区域 / 可见性 / 文本语义 ----------
// 这里 **没有任何站点名判断**（不存在 if(reddit) / if(tindie) / if(twitter)）：
// 四类规则全部是通用启发式，新增网站无需写适配代码。
//   1) 标签规则：脚本/样式/代码/表单控件等不可能承载正文的标签，整棵子树剪掉；
//   2) 区域规则：header / nav / footer / aside / 广告 / Cookie 条等非正文区域，整棵子树剪掉；
//      （例外见 isContentHeader：含 h1/h2 且不含 nav 的页头是正文标题区，按正文翻译）
//   3) 可见性规则：display:none、visibility:hidden、[hidden]、[aria-hidden]、[translate=no]；
//   4) 文本语义规则：纯数字/纯符号/emoji/URL/相对时间("3h")/已是目标语言 → 不值得发请求。
import {
  isMostlyNumeric, isTargetLanguageText, isTimeAgoToken,
  looksLikeUrlToken, normalizeSpace, onlyEmoji
} from './text.mjs';

/**
 * 整棵子树剪掉的标签：只放「结构上不可能承载可读正文」的标签。
 * BUTTON 默认剪掉（交互控件），选项页「翻译界面文案」可放行。
 */
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE',
  'SVG', 'MATH', 'CANVAS', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'VIDEO', 'AUDIO', 'TRACK', 'SOURCE', 'PICTURE', 'MAP', 'AREA', 'PARAM',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST', 'PROGRESS', 'METER',
  'BUTTON', 'OUTPUT',
  'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TT',
  'DIALOG', 'SLOT'
]);

/** 「翻译界面文案」开启后放行的标签（默认整棵剪掉） */
export const UI_LABEL_TAGS = new Set(['BUTTON']);

/**
 * 非正文区域选择器：命中即整棵子树剪掉。
 * 全部是通用规则（标准标签 + ARIA role + 广告/提示条的通用命名），不含任何站点专属类名。
 */
export const REGION_SELECTOR = [
  // 页面骨架：页头 / 导航 / 页脚 / 侧栏（顶栏一般只有菜单与语言切换，不是正文）
  'header', 'nav', 'footer', 'aside',
  '[role="navigation"]', '[role="contentinfo"]', '[role="banner"]', '[role="complementary"]',
  '[role="search"]', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="menubar"]',
  '[role="toolbar"]', '[role="tablist"]', '[role="form"]',
  // 无障碍隐藏 / 显式禁止翻译
  '[aria-hidden="true"]', '[hidden]', '[translate="no"]', '[translate="false"]',
  // 广告与推广位（通用命名启发式：命中类名/属性片段即可）
  '[class*="advert" i]', '[id*="advert" i]', '[data-ad]', '[data-ad-slot]', '[data-adunit]',
  '[class*="sponsor" i]', '[id*="sponsor" i]', '[aria-label*="advertis" i]',
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]',
  // 插件自身 UI 命名空间
  '[id^="ot-"]', '[class^="ot-"]', '[class*=" ot-"]'
].join(',');

/** 每次翻译会话一份规则实例：把「设置 → 规则」的换算集中在一处 */
export function buildRules(settings = {}, targetLang = 'zh-CN') {
  const skipTags = new Set(SKIP_TAGS);
  if (settings && settings.translateUiLabels === true) {
    for (const t of UI_LABEL_TAGS) skipTags.delete(t);
  }
  return {
    skipTags,
    targetLang: targetLang || 'zh-CN',
    skipRegions: !(settings && settings.skipNoise === false), // 只译正文区域（默认开）
    // 含 h1/h2 且不含 nav 的页头按正文翻译（站点顶栏仍被 skipRegions 剪掉）
    headerIsContent: !(settings && settings.headerIsContent === false),
    minChars: 2,     // 单字符（"·" / "|" / "1"）不值得一次请求
    maxChars: 4000,  // 单个 TextNode 超过这个长度就跳过（异常节点保护）
    cache: new WeakMap(),        // 元素级可见性缓存（一次扫描内复用，避免重复触发样式计算）
    displayCache: new WeakMap()  // 元素级 display 缓存（盒子类型判断复用）
  };
}

/** 元素是否要整棵剪掉（标签规则 + 区域规则 + contenteditable） */
export function isSkippableElement(el, rules) {
  if (!el || el.nodeType !== 1) return true;
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY') return false; // 根元素永远不剪
  if (rules.skipTags.has(tag)) return true;
  if (el.isContentEditable) return true;
  if (rules.skipRegions) {
    let hit = false;
    try {
      hit = typeof el.matches === 'function' && el.matches(REGION_SELECTOR);
    } catch (_) { /* 个别环境不支持复杂选择器语法，忽略 */ }
    if (hit) {
      // 唯一例外：承载主标题的页头（含 h1/h2 且不含 nav）属于正文标题区
      if (rules.headerIsContent !== false && isContentHeader(el)) return false;
      return true;
    }
  }
  return false;
}

/**
 * 元素当前是否可见。
 * 优先用原生 checkVisibility（Chrome 105+，一次调用穿透祖先链判断 display/visibility），
 * 没有则退回 computed style。结果按元素缓存，避免同一次扫描反复触发样式计算。
 */
export function isVisible(el, rules) {
  if (!el || el.nodeType !== 1) return true;
  const cache = rules.cache;
  const hit = cache.get(el);
  if (hit !== undefined) return hit;
  let vis = true;
  try {
    if (typeof el.checkVisibility === 'function') {
      vis = !!el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: false,   // 透明元素仍可能是正文（淡入动画未结束）
        visibilityProperty: true,
        displayProperty: true
      });
    } else {
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      const cs = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) vis = false;
    }
  } catch (_) { vis = true; }
  cache.set(el, vis);
  return vis;
}

/**
 * 行内盒子集合：以下 display 的元素不构成「段落边界」，句子可以穿过它继续。
 * none / contents 不产生盒子，也不该切断句子；table-row 之类的行内显示同理。
 */
export const INLINE_DISPLAYS = new Set([
  'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'inline-list-item',
  'contents', 'none', 'ruby', 'ruby-base', 'ruby-text',
  'table-row', 'table-row-group', 'table-column', 'table-column-group',
  'table-header-group', 'table-footer-group'
]);

/**
 * 元素的计算 display（带缓存：一次会话里同一个元素只触发一次样式计算）。
 * 取不到（脱离文档、环境受限）时返回空串，调用方按「行内」处理。
 */
export function displayOf(el, rules) {
  const cache = rules && rules.displayCache;
  if (cache) {
    const hit = cache.get(el);
    if (hit !== undefined) return hit;
  }
  let d = '';
  try {
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    if (win && win.getComputedStyle) d = String(win.getComputedStyle(el).display || '');
  } catch (_) { d = ''; }
  if (cache) cache.set(el, d);
  return d;
}

/** 该元素是不是行内盒子（不构成段落边界） */
export function isInlineBox(el, rules) {
  const d = displayOf(el, rules);
  if (!d) return true;              // 拿不到 display -> 当行内，继续往上找，宁可保守
  return INLINE_DISPLAYS.has(d);
}

/**
 * 文本节点所属的「合并容器」：最近的非行内祖先（段落 / 卡片 / 标题）。
 * 跨 shadow 边界时用宿主元素继续往上找。
 */
export function nearestBlockContainer(el, rules) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (!isInlineBox(cur, rules)) return cur;
    const up = cur.parentElement;
    if (up) { cur = up; continue; }
    const node = cur.getRootNode ? cur.getRootNode() : null;
    if (node && node.host) { cur = node.host; continue; }
    return cur;
  }
  return el;
}

/**
 * 页头例外：<header> / [role="banner"] 里如果承载主标题（h1/h2）且不含导航，
 * 它是文章标题区而不是站点骨架，应当按正文翻译。
 * 含导航的页头（站点顶栏）仍然剪掉 —— 顶栏一般只有菜单与语言切换。
 */
export function isContentHeader(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  let role = '';
  try { role = el.getAttribute ? (el.getAttribute('role') || '') : ''; } catch (_) { role = ''; }
  if (tag !== 'HEADER' && role !== 'banner') return false;
  if (typeof el.querySelector !== 'function') return false;
  try {
    if (el.querySelector('nav,[role="navigation"]')) return false;
    return !!el.querySelector('h1,h2');
  } catch (_) { return false; }
}

/** 文本节点所在元素（含 shadow root 直接子节点的兜底：取宿主元素） */
export function ownerElementOf(node) {
  if (!node) return null;
  if (node.parentElement) return node.parentElement;
  const p = node.parentNode;
  if (p && p.nodeType === 11 && p.host) return p.host;
  return null;
}

/** 一段文本是否值得翻译（文本语义规则，纯函数，便于单测） */
export function isTranslatableText(text, rules) {
  const t = normalizeSpace(text == null ? '' : String(text));
  if (!t) return false;
  if (t.length < rules.minChars) return false;
  if (t.length > rules.maxChars) return false;
  if (isMostlyNumeric(t)) return false;                        // 123 / $4.99 / 2024-01-01
  if (!/[\p{L}]/u.test(t)) return false;                       // 没有任何字母 → 符号串
  if (onlyEmoji(t)) return false;
  if (looksLikeUrlToken(t)) return false;
  if (isTimeAgoToken(t)) return false;                         // "3h" / "· 2d"
  if (isTargetLanguageText(t, rules.targetLang)) return false;  // 已经是目标语言
  return true;
}
