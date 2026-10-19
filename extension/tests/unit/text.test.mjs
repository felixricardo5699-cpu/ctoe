import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpace, scriptStats, isTargetLanguageText, shouldTranslateText, chunkText, hashText, isTimeAgoToken } from '../../src/core/text.mjs';

test('normalizeSpace 折叠空白并保留单个空格', () => {
  assert.equal(normalizeSpace('  Hello\u00A0  world \n again '), 'Hello world again');
});

test('scriptStats 统计各文字体系', () => {
  const s = scriptStats('Hello 你好 こんにちは 한국어');
  assert.ok(s.latin >= 5);
  assert.ok(s.han >= 2);
  assert.ok(s.kana >= 4);
  assert.ok(s.hangul >= 2);
});

test('zh 目标语言判定：纯中文为真，英/日/韩为假', () => {
  assert.equal(isTargetLanguageText('这是一段中文测试文字，无需翻译。', 'zh-CN'), true);
  assert.equal(isTargetLanguageText('This is English text that needs translation.', 'zh-CN'), false);
  assert.equal(isTargetLanguageText('これは日本語のテキストです。', 'zh-CN'), false);
  assert.equal(isTargetLanguageText('이것은 한국어 텍스트입니다.', 'zh-CN'), false);
  assert.equal(isTargetLanguageText('Mixed 中文内容 with some words', 'zh-CN'), false);
});

test('shouldTranslateText 过滤纯数字/符号', () => {
  assert.equal(shouldTranslateText('123,456.78%'), false);
  assert.equal(shouldTranslateText('Hello world'), true);
  assert.equal(shouldTranslateText('   '), false);
});

test('chunkText：长句按标点切且不超长', () => {
  const long = Array.from({ length: 60 }, (_, i) => `sentence number ${i} is a test.`).join(' ');
  const parts = chunkText(long, 800);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 800 + 1, 'chunk too long');
  assert.equal(parts.join(''), long);
});

test('chunkText：无标点超长文本硬切兜底', () => {
  const long = 'word '.repeat(5000).slice(0, -1);
  const parts = chunkText(long, 500);
  for (const p of parts) assert.ok(p.length <= 500);
  assert.equal(parts.join(''), long);
});

test('hashText 稳定且不同文本不同（绝大多数）', () => {
  assert.equal(hashText('hello world'), hashText('hello world'));
  assert.notEqual(hashText('hello world'), hashText('hello worlD'));
});

test('isTimeAgoToken 识别 X 风格时间', () => {
  assert.equal(isTimeAgoToken('2h'), true);
  assert.equal(isTimeAgoToken('· 3d'), true);
  assert.equal(isTimeAgoToken('A real message'), false);
});