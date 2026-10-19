// 合并层测试：Merge -> Translate -> Split 的边界判定。
// 重点钉死三件事：
//   1) 同一段落里被行内标签切开的句子要合并成一个单元（整句翻译，不再是碎片）；
//   2) 绝不跨块级元素 / <br> / 容器合并（两个帖子、两个商品标题、两个段落必须分开）；
//   3) 拆分不可信时整组作废、退回逐节点 —— 绝不猜着切、绝不 join 回单个节点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroups, splitTranslation, endsWithSpace, SEG } from '../../src/core/merge.mjs';
import { buildRules } from '../../src/core/rules.mjs';
import { TranslateQueue } from '../../src/core/queue.mjs';

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

// ---------- 极简假 DOM：只实现合并层真正用到的接口 ----------
function text(data) {
  return { nodeType: 3, data, parentNode: null, parentElement: null, isConnected: true };
}

function el(tag, kids = [], display = 'block') {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], parentNode: null, parentElement: null,
    isConnected: true, isContentEditable: false, attrs: {}, _display: display,
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    getAttribute(k) { return this.hasAttribute(k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    matches() { return false; },
    querySelector(sel) { const hit = qall(this, sel); return hit.length ? hit[0] : null; },
    getRootNode() { let c = this; while (c.parentNode) c = c.parentNode; return c; }
  };
  // 与真实 DOM 一致：元素内文本节点的 parentElement 就是该元素
  for (const kid of kids) { kid.parentNode = node; kid.parentElement = node; }
  node.childNodes = kids.slice();
  return node;
}

function partHit(node, parts) {
  for (const p of parts) {
    if (p.charAt(0) === '[') {
      const inner = p.slice(1, p.length - 1);
      const eq = inner.indexOf('=');
      if (eq > 0) {
        const name = inner.slice(0, eq).trim();
        let val = inner.slice(eq + 1).trim();
        if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') val = val.slice(1, -1);
        if (node.getAttribute(name) === val) return true;
      }
    } else if (node.tagName === p.toUpperCase()) return true;
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

function makeWalker(root, accept) {
  const q = [];
  const visit = (n) => {
    for (const kid of n.childNodes || []) {
      if (kid.nodeType !== 1) continue;
      const r = accept(kid);
      if (r === FILTER_REJECT) continue;
      if (r === FILTER_ACCEPT) q.push(kid);
      visit(kid);
    }
  };
  visit(root);
  let i = 0;
  return { nextNode() { return i < q.length ? q[i++] : null; } };
}

function mount(rootEl) {
  const order = [];
  const visit = (n) => { order.push(n); for (const kid of n.childNodes || []) visit(kid); };
  visit(rootEl);
  const doc = { nodeType: 9, host: null };
  doc.defaultView = { getComputedStyle: (e) => ({ display: e._display }) };
  doc.createTreeWalker = (r, show, accept) => makeWalker(r, accept);
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    n.__order = i;
    if (n.nodeType === 1) n.ownerDocument = doc;
    n.compareDocumentPosition = function (other) {
      if (!other || other.__order === undefined) return 0;
      if (other.__order > this.__order) return 4;
      if (other.__order < this.__order) return 2;
      return 0;
    };
  }
  return doc;
}

function collectTexts(root) {
  const out = [];
  const visit = (n) => {
    for (const kid of n.childNodes || []) {
      if (kid.nodeType === 3) out.push(kid);
      else visit(kid);
    }
  };
  visit(root);
  return out;
}

const rules = () => buildRules({}, 'zh-CN');

// ---------- buildGroups ----------

test('行内标签切开的同一句话合并成一个单元，片段顺序不变', () => {
  const t1 = text('Please read the ');
  const t2 = text('official docs');
  const t3 = text(' and press ');
  const t4 = text('Send feedback');
  const t5 = text(' to continue.');
  const para = el('p', [t1, el('a', [t2], 'inline'), t3, el('b', [t4], 'inline'), t5]);
  const body = el('body', [para]);
  mount(body);
  const groups = buildGroups(collectTexts(body), rules());
  assert.equal(groups.length, 1, '整句合成一个翻译单元');
  assert.equal(groups[0].merged, true);
  assert.deepEqual(groups[0].nodes, [t1, t2, t3, t4, t5]);
  assert.equal(groups[0].text, 'Please read the ' + SEG + 'official docs' + SEG + ' and press ' + SEG + 'Send feedback' + SEG + ' to continue.');
});

test('块级子元素之间不合并：多个段落 / 多个帖子各自成单元', () => {
  const a = text('First post body sentence about open source hardware threads.');
  const b = text('Second post body sentence about index fund allocation.');
  const c = text('Third post body sentence about soldering irons.');
  const body = el('body', [el('p', [a]), el('p', [b]), el('p', [c])]);
  mount(body);
  const groups = buildGroups(collectTexts(body), rules());
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.merged), [false, false, false]);
  assert.deepEqual(groups.map((g) => g.text), [a.data, b.data, c.data]);
});

test('同容器内被块级盒子隔开的片段不合并', () => {
  const a = text('Title of the first product card');
  const b = text('Title of the second product card');
  const card1 = el('div', [a], 'block');
  const card2 = el('div', [b], 'block');
  const grid = el('div', [card1, card2], 'block');
  mount(el('body', [grid]));
  const groups = buildGroups(collectTexts(grid), rules());
  assert.equal(groups.length, 2, '两个块级卡片各自成单元');
});

test('<br> 会切断合并（换行即句子边界）', () => {
  const a = text('First line of the description');
  const br = el('br', [], 'inline');
  const b = text('Second line of the description');
  const body = el('body', [el('p', [a, br, b])]);
  mount(body);
  const groups = buildGroups(collectTexts(body), rules());
  assert.equal(groups.length, 2);
});

test('不译子树（图片 / 播放器 / 表单控件）不切断句子，句子照常合并', () => {
  const a = text('The ');
  const b = text(' board ships worldwide from the Tindie store.');
  const img = el('img', [], 'inline');
  const para = el('p', [a, img, b]);
  const body = el('body', [para]);
  mount(body);
  const groups = buildGroups(collectTexts(body), rules());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merged, true);
  assert.equal(groups[0].text, 'The ' + SEG + ' board ships worldwide from the Tindie store.');
});

test('合并长度受限：超长段落按上限切成多个单元（不会拼成一条巨型请求）', () => {
  const kids = [];
  for (let i = 0; i < 40; i++) kids.push(text('Sentence number ' + i + ' about open source hardware.'));
  const body = el('body', [el('p', kids)]);
  mount(body);
  const groups = buildGroups(collectTexts(body), rules(), { maxSegments: 6 });
  assert.equal(groups.length, Math.ceil(40 / 6));
  for (const g of groups) assert.ok(g.nodes.length <= 6);
  const short = buildGroups(collectTexts(body), rules(), { maxChars: 60 });
  assert.ok(short.length > 1, '字符上限同样生效');
});

test('标记为 solo 的节点不参与合并（拆分失败后的降级路径）', () => {
  const t1 = text('Please read the ');
  const t2 = text('official docs');
  const para = el('p', [t1, el('a', [t2], 'inline')]);
  const body = el('body', [para]);
  mount(body);
  const solo = new WeakSet();
  solo.add(t2);
  const groups = buildGroups(collectTexts(body), rules(), { isSolo: (n) => solo.has(n) });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.merged), [false, false]);
});

// ---------- splitTranslation ----------

test('splitTranslation 按分隔符切回，且顺序与原文片段一致', () => {
  const translated = '译文一' + SEG + '译文二' + SEG + '译文三';
  assert.deepEqual(splitTranslation(translated, 3), ['译文一', '译文二', '译文三']);
  assert.deepEqual(splitTranslation('  单段译文  ', 1), ['单段译文']);
});

test('分隔符被引擎吞掉 / 复制 / 挪动 -> 一律返回 null（调用方必须退回逐节点）', () => {
  assert.equal(splitTranslation('译文一译文二', 2), null, '吞掉分隔符');
  assert.equal(splitTranslation('一' + SEG + '二' + SEG + '三', 2), null, '片段数不符');
  assert.equal(splitTranslation('一' + SEG + ' ' + SEG + '三', 3), null, '出现空片段');
});

test('endsWithSpace 用于避免相邻片段之间出现两个空格', () => {
  assert.equal(endsWithSpace('abc '), true);
  assert.equal(endsWithSpace('abc'), false);
  assert.equal(endsWithSpace(''), false);
  assert.equal(endsWithSpace(null), false);
});

// ---------- 队列集成：合并 -> 请求 -> 拆分 -> 各自回写 ----------

function fakeDomPara() {
  const t1 = text('Please read the ');
  const t2 = text('official docs');
  const t3 = text(' to continue.');
  const para = el('p', [t1, el('a', [t2], 'inline'), t3]);
  const body = el('body', [para]);
  mount(body);
  return { nodes: collectTexts(body), t1, t2, t3 };
}

function queueFor(nodes, engine, rulesObj) {
  const got = [];
  const q = new TranslateQueue({
    engine,
    getRules: () => rulesObj,
    onResult: (node, translated, opts) => got.push([node, translated, opts]),
    onFail: () => {}
  });
  for (const n of nodes) q.push(n, n.data);
  return { q, got };
}

test('队列：合并单元只发一次请求，三个节点各自拿到自己的片段（不 join 回单节点）', async () => {
  const { nodes, t1, t2, t3 } = fakeDomPara();
  const engine = { tl: 'zh-CN', cacheTag: 't', calls: [], async translateMany(list) {
    this.calls.push(list.slice());
    const ok = new Map();
    for (const t of list) ok.set(t, '【译】' + t);
    return { ok };
  } };
  const { q, got } = queueFor(nodes, engine, rules());
  await q.drain();
  assert.equal(engine.calls.length, 1, '整句一次请求');
  assert.equal(engine.calls[0].length, 1);
  assert.ok(engine.calls[0][0].includes(SEG), '请求里带片段分隔符');
  const byNode = new Map(got.map(([n, t]) => [n, t]));
  // 片段是切回来的原文片段（首尾空白由回写层按原文补，见 writer.keepBoundarySpace）
  assert.equal(byNode.get(t1), '【译】Please read the');
  assert.equal(byNode.get(t2), 'official docs');
  assert.equal(byNode.get(t3), 'to continue.');
  // 换行处的空格只补一次：上一片段已带尾空格时，本片段不再补首空格
  const opts = new Map(got.map(([n, , o]) => [n, o]));
  assert.deepEqual(opts.get(t1), { keepLeading: true });
  assert.deepEqual(opts.get(t2), { keepLeading: false });
  assert.deepEqual(opts.get(t3), { keepLeading: true });
  assert.equal(q.stats.merged, 1);
  assert.equal(q.stats.splitFailed, 0);
});

test('队列：引擎吞掉分隔符 -> 整组退回逐节点翻译，仍然一字不差', async () => {
  const { nodes, t1, t2, t3 } = fakeDomPara();
  const engine = { tl: 'zh-CN', cacheTag: 't', calls: [], async translateMany(list) {
    this.calls.push(list.slice());
    const ok = new Map();
    for (const t of list) ok.set(t, '【译】' + t.split(SEG).join(''));
    return { ok };
  } };
  const { q, got } = queueFor(nodes, engine, rules());
  await q.drain();
  assert.equal(q.stats.splitFailed, 1, '识别出边界不可信');
  assert.equal(q.stats.merged, 0);
  const byNode = new Map(got.map(([n, t]) => [n, t]));
  assert.equal(byNode.get(t1), '【译】Please read the ');
  assert.equal(byNode.get(t2), '【译】official docs');
  assert.equal(byNode.get(t3), '【译】 to continue.');
  assert.equal(engine.calls.length, 2, '第一次合并失败 + 第二次逐条');
  assert.equal(q.pending.size, 0, '不会无限重试');
});

test('队列：sentenceMerge 关闭时逐节点翻译（纯文本节点语义）', async () => {
  const { nodes } = fakeDomPara();
  const engine = { tl: 'zh-CN', cacheTag: 't', calls: [], async translateMany(list) {
    this.calls.push(list.slice());
    const ok = new Map();
    for (const t of list) ok.set(t, '【译】' + t);
    return { ok };
  } };
  const got = [];
  const q = new TranslateQueue({ engine, sentenceMerge: false, getRules: () => rules(),
    onResult: (n, t) => got.push([n, t]), onFail: () => {} });
  for (const n of nodes) q.push(n, n.data);
  await q.drain();
  assert.equal(engine.calls.length, 1);
  assert.deepEqual(engine.calls[0], nodes.map((n) => n.data));
  assert.ok(!engine.calls[0].some((t) => t.includes(SEG)));
  assert.equal(got.length, 3);
});
