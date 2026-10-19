// 回写层测试：只允许改 TextNode.data，且原文可无损还原。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextWriter, keepBoundarySpace } from '../../src/core/writer.mjs';

// 极简假 DOM：只实现回写层真正用到的接口
function mkText(data) {
  return { nodeType: 3, data, isConnected: true, parentElement: null };
}
function mkEl(tag, kids = [], display = 'block') {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), isConnected: true, isContentEditable: false,
    childNodes: kids, attrs: {}, style: {}, parentElement: null, ownerDocument: null,
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.hasAttribute(k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; }
  };
  el.ownerDocument = { defaultView: { getComputedStyle: () => ({ display }) } };
  for (const kid of kids) {
    kid.parentElement = el;
    kid.parentNode = el;
  }
  return el;
}

test('write 只改 node.data，不新增/删除子节点', () => {
  const t = mkText('Hello world from the store');
  const el = mkEl('p', [t]);
  const before = el.childNodes.slice();
  const w = new TextWriter();
  assert.equal(w.write(t, '【译】你好世界'), true);
  assert.equal(t.data, '【译】你好世界');
  assert.equal(el.childNodes.length, before.length);
  assert.deepEqual(el.childNodes, before, '节点列表（身份与顺序）完全不变');
  assert.equal(el.attrs['data-ot-done'], '1', '只挂标记属性');
});

test('isOurs 用于识别「自己写进去的译文」，页面改写后立刻失效', () => {
  const t = mkText('Hello world from the store');
  const el = mkEl('p', [t]);
  const w = new TextWriter();
  assert.equal(w.isOurs(t), false);
  w.write(t, '【译】你好世界');
  assert.equal(w.isOurs(t), true);
  t.data = 'Completely new comment text';  // 页面复用节点换入新文本
  assert.equal(w.isOurs(t), false, '必须重新翻译');
  assert.equal(w.hasOriginal(t), true, '原文仍然记着（还原用）');
});

test('restoreAll 逐节点还原原文并摘掉所有标记', () => {
  const t1 = mkText('First paragraph text');
  const t2 = mkText('Second paragraph text');
  const el = mkEl('div', [t1, t2]);
  const w = new TextWriter();
  w.write(t1, '【译】一');
  w.write(t2, '【译】二');
  assert.equal(w.count, 2);
  assert.equal(w.restoreAll(), 2);
  assert.equal(t1.data, 'First paragraph text');
  assert.equal(t2.data, 'Second paragraph text');
  assert.equal(el.attrs['data-ot-done'], undefined);
  assert.equal(w.count, 0);
});

test('双语模式：只挂属性（伪元素渲染原文），DOM 结构不变', () => {
  const t = mkText('Hello world from the store');
  const el = mkEl('p', [t]);
  const w = new TextWriter({ mode: 'bilingual' });
  w.write(t, '【译】你好世界');
  assert.equal(el.attrs['data-ot-src'], 'Hello world from the store');
  assert.equal(el.childNodes.length, 1, '没有新增任何节点');
  assert.equal(t.data, '【译】你好世界', '译文仍在原文本节点里');
});

test('双语模式：同一元素还有未译文本子节点时不挂原文（避免重复展示）', () => {
  const t1 = mkText('Translated sentence here');
  const t2 = mkText('Untranslated sentence here');
  const el = mkEl('p', [t1, t2]);
  const w = new TextWriter({ mode: 'bilingual' });
  w.write(t1, '【译】已译');
  assert.equal(el.attrs['data-ot-src'], undefined);
});

test('双语模式：flex / inline 容器不挂伪元素（不改变排版）', () => {
  for (const display of ['flex', 'grid', 'inline', 'inline-block']) {
    const t = mkText('Hello world from the store');
    const el = mkEl('div', [t], display);
    const w = new TextWriter({ mode: 'bilingual' });
    w.write(t, '【译】你好世界');
    assert.equal(el.attrs['data-ot-src'], undefined, display + ' 容器不应挂双语属性');
    assert.equal(t.data, '【译】你好世界', '但译文照常写入');
  }
});

test('切换显示方式不需要重排 DOM', () => {
  const t = mkText('Hello world from the store');
  const el = mkEl('p', [t]);
  const w = new TextWriter({ mode: 'replace' });
  w.write(t, '【译】你好世界');
  assert.equal(el.attrs['data-ot-src'], undefined);
  w.setMode('bilingual');
  assert.equal(el.attrs['data-ot-src'], 'Hello world from the store');
  w.setMode('replace');
  assert.equal(el.attrs['data-ot-src'], undefined);
  assert.equal(t.data, '【译】你好世界');
});

test('prune 回收已摘除节点', () => {
  const t = mkText('Hello world from the store');
  const el = mkEl('p', [t]);
  const w = new TextWriter();
  w.write(t, '【译】你好世界');
  t.isConnected = false;
  assert.equal(w.prune(), 1);
  assert.equal(w.count, 0);
});

test('标记挂在最近的块级祖先上（行内标签包着的文字不会把标记打在 <b> 上）', () => {
  const t = mkText('Breaking news from the open source hardware world today.');
  const p = mkEl('p', []);
  const b = mkEl('b', [t], 'inline');
  b.parentElement = p;
  p.childNodes = [b];
  const w = new TextWriter();
  w.write(t, '【译】开放源代码硬件世界今日要闻。');
  assert.equal(p.attrs['data-ot-done'], '1', '标记应落在段落这一层');
  assert.equal(b.attrs['data-ot-done'], undefined);
  assert.equal(p.childNodes.length, 1, '没有新增任何节点');
});

test('双语对照：整段译完后挂上完整原文（含行内标签里的字）', () => {
  const t1 = mkText('Breaking ');
  const t2 = mkText('news from the open source hardware world today.');
  const p = mkEl('p', []);
  const b = mkEl('b', [t1], 'inline');
  b.parentElement = p;
  p.childNodes = [b, t2];
  t2.parentElement = p;
  const w = new TextWriter({ mode: 'bilingual' });
  w.write(t1, '【译】突发 ');
  assert.equal(p.attrs['data-ot-src'], undefined, '还有没译完的部分时不展示原文');
  w.write(t2, '【译】开放源代码硬件世界今日要闻。');
  assert.equal(p.attrs['data-ot-src'], 'Breaking news from the open source hardware world today.');
  assert.equal(p.childNodes.length, 2, 'DOM 结构不变');
});

test('keepBoundarySpace 保住相邻片段之间的空格（不会被粘成 docs【译】and）', () => {
  assert.equal(keepBoundarySpace('译文', ' text'), ' 译文');
  assert.equal(keepBoundarySpace('译文', 'text '), '译文 ');
  assert.equal(keepBoundarySpace('译文', ' text '), ' 译文 ');
  assert.equal(keepBoundarySpace('  译文  ', 'text'), '译文');
  assert.equal(keepBoundarySpace('译文', 'text'), '译文');
});

test('write 会保留原文首尾空白，行内片段拼接后与原文一致', () => {
  const t1 = mkText('Please read the ');
  const t2 = mkText('official docs');
  const t3 = mkText(' and press ');
  const p = mkEl('p', [t1, t2, t3]);
  const w = new TextWriter();
  const orig = p.childNodes.map((n) => n.data).join('');
  for (const n of [t1, t2, t3]) w.write(n, '【译】' + n.data.trim());
  const merged = p.childNodes.map((n) => n.data).join('').replace(/【译】/g, '');
  assert.equal(merged, orig, '去掉译文前缀后应与原文逐字一致（空格不丢）');
});
