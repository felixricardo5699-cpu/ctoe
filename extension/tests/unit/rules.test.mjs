// 过滤规则层的策略测试：把「哪些文本该翻、哪些区域该跳过」钉死，
// 保证新增网站只靠通用规则覆盖，不靠站点特判。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, isTranslatableText, isSkippableElement, isContentHeader, isInlineBox, nearestBlockContainer, SKIP_TAGS, REGION_SELECTOR, UI_LABEL_TAGS } from '../../src/core/rules.mjs';

const zh = () => buildRules({ skipNoise: true, translateUiLabels: false }, 'zh-CN');

test('跳过标签覆盖需求里点名的标签', () => {
  for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON']) {
    assert.ok(SKIP_TAGS.has(tag), tag + ' 应该在跳过列表里');
  }
});

test('区域规则覆盖 header / nav / footer / aside 与广告', () => {
  for (const part of ['header', 'nav', 'footer', 'aside']) assert.ok(REGION_SELECTOR.split(',').includes(part), part);
  assert.match(REGION_SELECTOR, /advert/);
  assert.match(REGION_SELECTOR, /role="navigation"/);
});

test('规则层不含任何站点名判断（新增站点零适配）', () => {
  assert.doesNotMatch(REGION_SELECTOR, /reddit|tindie|twitter|hackaday|youtube|github|linkedin|facebook/i);
  assert.doesNotMatch([...SKIP_TAGS].join(','), /shreddit|ytd-|faceplate/i);
});

test('翻译界面文案开关只影响 BUTTON', () => {
  const off = buildRules({ translateUiLabels: false }, 'zh-CN');
  const on = buildRules({ translateUiLabels: true }, 'zh-CN');
  assert.ok(off.skipTags.has('BUTTON'));
  assert.ok(!on.skipTags.has('BUTTON'));
  assert.ok(on.skipTags.has('SCRIPT'));
  assert.deepEqual([...UI_LABEL_TAGS], ['BUTTON']);
});

test('skipNoise 关闭后不再按区域剪枝', () => {
  assert.equal(buildRules({ skipNoise: false }, 'zh-CN').skipRegions, false);
  assert.equal(zh().skipRegions, true);
});

test('文本语义过滤：值得译的句子通过', () => {
  const r = zh();
  assert.ok(isTranslatableText('The board ships worldwide from the Tindie store.', r));
  assert.ok(isTranslatableText('  a bit of whitespace  ', r));
});

test('文本语义过滤：数字 / 时间 / URL / emoji / 目标语言 一律不发请求', () => {
  const r = zh();
  assert.ok(!isTranslatableText('123', r));
  assert.ok(!isTranslatableText('$4.99', r));
  assert.ok(!isTranslatableText('3h', r));
  assert.ok(!isTranslatableText('· 2d', r));
  assert.ok(!isTranslatableText('https://example.com/a', r));
  assert.ok(!isTranslatableText('🙂🙂', r));
  assert.ok(!isTranslatableText('这已经是中文了', r));
  assert.ok(!isTranslatableText('x', r), '单字符不发请求');
  assert.ok(!isTranslatableText('   ', r));
});

test('文本语义过滤：超长单节点跳过（异常节点保护）', () => {
  const r = zh();
  assert.ok(!isTranslatableText('a'.repeat(r.maxChars + 1), r));
});

// ---------- 页头例外：含 h1/h2 且不含 nav 的页头属于正文 ----------
function partHit(node, parts) {
  for (const part of parts) {
    if (part.charAt(0) === '[') {
      const inner = part.slice(1, part.length - 1);
      const eq = inner.indexOf('=');
      if (eq > 0) {
        const name = inner.slice(0, eq).trim();
        let val = inner.slice(eq + 1).trim();
        if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') val = val.slice(1, -1);
        if (node.getAttribute(name) === val) return true;
      }
    } else if (node.tagName === part.toUpperCase()) return true;
  }
  return false;
}

function qall(root, sel) {
  const parts = String(sel).split(',').map((x) => x.trim());
  const out = [];
  const visit = (n) => {
    for (const kid of n.childNodes || []) {
      if (kid.nodeType !== 1) continue;
      if (partHit(kid, parts)) out.push(kid);
      visit(kid);
    }
  };
  visit(root);
  return out;
}

function el(tag, kids = [], attrs = {}, inRegion = false) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: kids, isContentEditable: false, attrs,
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    getAttribute(k) { return this.hasAttribute(k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    matches(sel) { return sel === REGION_SELECTOR ? inRegion : false; },
    querySelector(sel) { const r = qall(this, sel); return r.length ? r[0] : null; }
  };
}

const header = (kids, attrs) => el('header', kids, attrs, true);
const nav = () => el('nav', [], {}, true);
const h1 = () => el('h1');
const h2 = () => el('h2');
const h3 = () => el('h3');
const p = () => el('p');

test('页头含 h1/h2 且不含 nav -> 按正文翻译', () => {
  const r = zh();
  assert.equal(isSkippableElement(header([h1(), p()]), r), false, 'h1 页头是正文标题区');
  assert.equal(isSkippableElement(header([h2()]), r), false, 'h2 页头同样是正文');
  assert.equal(isContentHeader(header([h1()])), true);
});

test('页头含导航 / 没有标题 -> 仍然按非正文剪掉', () => {
  const r = zh();
  assert.equal(isSkippableElement(header([h1(), nav()]), r), true, '含 nav 的页头是站点顶栏');
  assert.equal(isSkippableElement(header([nav()]), r), true);
  assert.equal(isSkippableElement(header([p()]), r), true, '没有 h1/h2 的页头不算正文');
  assert.equal(isSkippableElement(header([h3()]), r), true, 'h3 不足以判定为正文标题区');
});

test('页头例外只作用于 header / [role=banner]，nav / footer / aside 照旧剪掉', () => {
  const r = zh();
  assert.equal(isSkippableElement(el('nav', [h1()], {}, true), r), true);
  assert.equal(isSkippableElement(el('footer', [h1()], {}, true), r), true);
  assert.equal(isSkippableElement(el('aside', [h1()], {}, true), r), true);
  assert.equal(isSkippableElement(el('div', [h1()], { role: 'banner' }, true), r), false, '[role=banner] 与 header 同义');
  assert.equal(isSkippableElement(el('div', [h1(), nav()], { role: 'banner' }, true), r), true);
});

test('页头例外可通过设置关闭（不需要改代码）', () => {
  const off = buildRules({ headerIsContent: false }, 'zh-CN');
  assert.equal(off.headerIsContent, false);
  assert.equal(isSkippableElement(header([h1()]), off), true);
  const on = buildRules({}, 'zh-CN');
  assert.equal(on.headerIsContent, true);
});

// ---------- 盒子类型：合并层与回写层共用同一套「行内 / 块级」判定 ----------
function styled(tag, display, kids = []) {
  const node = el(tag, kids);
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({ display }) } };
  for (const kid of kids) kid.parentElement = node;
  return node;
}

test('isInlineBox：行内/行内块不算段落边界，块级/flex/grid 算', () => {
  const r = zh();
  assert.equal(isInlineBox(styled('span', 'inline'), r), true);
  assert.equal(isInlineBox(styled('a', 'inline-block'), r), true);
  assert.equal(isInlineBox(styled('div', 'contents'), r), true);
  assert.equal(isInlineBox(styled('p', 'block'), r), false);
  assert.equal(isInlineBox(styled('div', 'flex'), r), false);
  assert.equal(isInlineBox(styled('div', 'grid'), r), false);
});

test('nearestBlockContainer：穿过行内标签找到段落 / 卡片', () => {
  const r = zh();
  const card = styled('li', 'block');
  const link = styled('a', 'inline');
  const span = styled('b', 'inline');
  link.parentElement = card;
  span.parentElement = link;
  assert.equal(nearestBlockContainer(span, r), card, '最靠近文本节点的非行内祖先是卡片');
  const onlyInline = styled('div', 'inline');
  onlyInline.parentElement = card;
  assert.equal(nearestBlockContainer(onlyInline, r), card);
});
