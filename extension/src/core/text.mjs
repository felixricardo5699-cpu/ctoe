// ---------- 文本判定 / 清洗 / 切句 / 指纹 ----------
import { sha256Hex } from './sha256.mjs';

// 说明：这里不再有任何占位符（token）机制。旧的「把整块容器的文字抽成一条模板、再用 token 回填」
// 架构已随 units.mjs / translate-html.mjs 一并移除：翻译单元就是单个 TextNode，回写就是 node.data = 译文。


const HAN_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
const KANA_RE = /[\u3040-\u30FF]/g;
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF]/g;
const LATIN_RE = /[A-Za-z]/g;
const CYR_RE = /[\u0400-\u04FF]/g;
const LETTER_RE = /[\p{L}]/gu;

export function hashText(str) {
  // 缓存键 = sha256(原文)：指纹太短会串号，把别的句子译文贴到当前页面上（“对不上”的元凶之一）。
  // 256bit 输出后碰撞概率可忽略；同步实现，不引入 await 到翻译热路径。
  return sha256Hex(String(str));
}

export function scriptStats(s) {
  const n = Math.max(1, (s.match(LETTER_RE) || []).length);
  return {
    han: (s.match(HAN_RE) || []).length,
    kana: (s.match(KANA_RE) || []).length,
    hangul: (s.match(HANGUL_RE) || []).length,
    latin: (s.match(LATIN_RE) || []).length,
    cyr: (s.match(CYR_RE) || []).length,
    letters: n
  };
}

/** 文本是否为“目标语言”而无需翻译 */
export function isTargetLanguageText(text, targetLang) {
  const fam = String(targetLang || '').toLowerCase().startsWith('zh') ? 'zh' : String(targetLang || '').toLowerCase();
  const st = scriptStats(text);
  const ratio = st.letters ? (st.han + st.kana + st.hangul + st.latin + st.cyr) / st.letters : 0;
  if (ratio < 0.5) return false; // 数字/标点为主
  if (fam === 'zh') {
    // 简体中文：汉字多且无假名/谚文
    if (st.han > 0 && st.kana === 0 && st.hangul === 0 && st.han / st.letters > 0.55) return true;
    // 纯拉丁短词不需要（en 源）
    return false;
  }
  if (fam === 'en') return st.latin > 0 && st.latin / st.letters > 0.85;
  if (fam === 'ja') return st.kana > 0 && st.kana / st.letters > 0.5;
  if (fam === 'ko') return st.hangul > 0 && st.hangul / st.letters > 0.8;
  if (fam === 'ru') return st.cyr > 0 && st.cyr / st.letters > 0.8;
  return st.latin > 0 && st.latin / st.letters > 0.85; // latin 系
}

export function isMostlyNumeric(s) { return NUMERIC_RE(s); }
function NUMERIC_RE(s) { return /^\s*[\d\s.,%$€£¥+\-():;*x/°·±‰@#&!?'"_=<>|\\[\]{}^~`]+\s*$/.test(s); }

const NORM_RE = /[\u00A0\u2000-\u200B\u202F\uFEFF\u2028\u2029]/g;
const WS_RE = /[ \t\r\n\f]+/g;

/** 规范化文本：替换不断行空格、折叠空白 */
export function normalizeSpace(s) {
  return s.replace(NORM_RE, ' ').replace(WS_RE, ' ').trim();
}

/** 可翻译性判断（已被 unit 过滤过） */
export function shouldTranslateText(s) {
  const t = normalizeSpace(s);
  if (!t) return false;
  if (isMostlyNumeric(t)) return false;
  if (!/[\p{L}]/u.test(t)) return false;
  return true;
}

/** 简单的整句切割，避免切坏 -> {sentences:[], joined:''} */
export function chunkText(text, maxLen = 1300) {
  if (text.length <= maxLen) return [text];
  const out = [];
  let cur = '';
  // 以句子为单位
  const parts = String(text).split(/(?<=[.!?。！？；;])/u);
  for (const part of parts) {
    if (cur.length + part.length + 1 > maxLen && cur) {
      out.push(cur); cur = part;
    } else cur += part;
  }
  if (cur) out.push(cur);
  // 极端长无标点：硬切兜底
  const final = [];
  for (const chunk of out) {
    if (chunk.length <= maxLen) { final.push(chunk); continue; }
    for (let i = 0; i < chunk.length; i += maxLen) final.push(chunk.slice(i, i + maxLen));
  }
  return final;
}

export function cleanForAttr(s) { return normalizeSpace(s); }

/** 相对时间片段（3h / 2d / · 3h）不值得翻译：纯语法规则，与站点无关 */
export function isTimeAgoToken(s) {
  return /^\s*\d+\s*[smhdw](\s*·?\s*\d*\s*[smhdw])?\s*$/i.test(s) ||
         /^\s*·\s*\d+\s*[smhdw]\s*$/i.test(s);
}

export function looksLikeUrlToken(s) {
  return /^\s*(https?:\/\/\S+|www\.\S+|\S+\.(com|org|net|io|co|me|tv|gg)\/\S*)\s*$/i.test(s);
}

export function onlyEmoji(s) {
  return /^\s*[\p{Extended_Pictographic}\u200d\ufe0f\s]{1,}\s*$/u.test(s);
}
