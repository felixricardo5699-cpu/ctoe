// 缓存键 = sha256(原文)：指纹必须稳定、且不同文本几乎不可能相撞
// （旧实现 32bit FNV 会串号，把别的句子译文贴到当前页面上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../src/core/sha256.mjs';
import { hashText } from '../../src/core/text.mjs';

const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex 与 node:crypto 完全一致（含多字节/emoji/长文本）', () => {
  const cases = ['', 'abc', 'The quick brown fox jumps over the lazy dog', '中文测试 · 万译 🎉', 'a'.repeat(1000), 'é'.repeat(200)];
  for (const s of cases) assert.equal(sha256Hex(s), nodeSha(s), JSON.stringify(s.slice(0, 12)));
  // 55/56/64 字节附近是补位边界，必须覆盖
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 121]) {
    const s = 'x'.repeat(n);
    assert.equal(sha256Hex(s), nodeSha(s), 'len=' + n);
  }
});

test('sha256Hex 对相同输入稳定，对不同输入不同', () => {
  assert.equal(sha256Hex('hello world'), sha256Hex('hello world'));
  assert.notEqual(sha256Hex('hello world'), sha256Hex('hello worlD'));
  assert.equal(sha256Hex('a').length, 64);
});

test('hashText 用 sha256（缓存键可跨版本校验）', () => {
  assert.equal(hashText('Hello world'), nodeSha('Hello world'));
});