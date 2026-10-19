// 队列 + 映射层测试：一次批量请求里放多条独立文本，回写时严格 node[i] <- text[i]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslateQueue } from '../../src/core/queue.mjs';
import { TranslateCache } from '../../src/core/cache.mjs';

function textNode(data, connected = true) {
  return { nodeType: 3, data, isConnected: connected, parentElement: null };
}

function fakeEngine(mapText = (t) => '【译】' + t) {
  return {
    tl: 'zh-CN',
    cacheTag: 'mock',
    calls: [],
    async translateMany(texts) {
      this.calls.push(texts.slice());
      const ok = new Map();
      for (const t of texts) ok.set(t, mapText(t));
      return { ok };
    }
  };
}

function run(items, opts = {}) {
  const engine = opts.engine || fakeEngine();
  const cache = new TranslateCache({ limit: 100 });
  const got = [];
  const failed = [];
  const q = new TranslateQueue({
    engine,
    cache,
    batchSize: opts.batchSize || 150,
    onResult: (node, text) => got.push([node, text]),
    onFail: (node) => failed.push(node)
  });
  for (const [node, text] of items) q.push(node, text);
  return q.drain().then(() => ({ engine, cache, got, failed }));
}

test('三个节点 → 一次批量请求 → 每个节点拿到自己那段文本的译文', async () => {
  const a = textNode('Alpha paragraph text');
  const b = textNode('Beta paragraph text');
  const c = textNode('Gamma paragraph text');
  const { engine, got } = await run([[a, a.data], [b, b.data], [c, c.data]]);
  assert.equal(engine.calls.length, 1, '三条文本合并成一次请求');
  assert.deepEqual(engine.calls[0], ['Alpha paragraph text', 'Beta paragraph text', 'Gamma paragraph text']);
  assert.deepEqual(got.map(([n, t]) => [n.data, t]), [
    ['Alpha paragraph text', '【译】Alpha paragraph text'],
    ['Beta paragraph text', '【译】Beta paragraph text'],
    ['Gamma paragraph text', '【译】Gamma paragraph text']
  ]);
  for (const [n] of got) assert.ok(got.filter(([m]) => m === n).length === 1, '每个节点只写一次');
});

test('绝不把多段文本拼成一条请求：请求里的每一项都是独立的原文', async () => {
  const nodes = [textNode('First post title'), textNode('Second post title'), textNode('Third post title')];
  const { engine } = await run(nodes.map((n) => [n, n.data]));
  const sent = engine.calls.flat();
  assert.equal(sent.length, 3);
  for (const one of sent) {
    assert.ok(!sent.some((other) => other !== one && other.includes(one)), '没有跨文本拼接');
    assert.ok(!one.includes('\n') && !one.includes(' / '), '没有分隔符拼接');
  }
});

test('相同文本的多个节点共用一次请求，但仍各自回写', async () => {
  const a = textNode('Add to cart');
  const b = textNode('Add to cart');
  const c = textNode('Buy now');
  const { engine, got } = await run([[a, a.data], [b, b.data], [c, c.data]]);
  assert.deepEqual(engine.calls[0].sort(), ['Add to cart', 'Buy now']);
  const byNode = new Map(got.map(([n, t]) => [n, t]));
  assert.equal(byNode.get(a), '【译】Add to cart');
  assert.equal(byNode.get(b), '【译】Add to cart');
  assert.equal(byNode.get(c), '【译】Buy now');
});

test('引擎漏返回某条 → 该节点计失败，绝不拿别人的译文顶上', async () => {
  const engine = fakeEngine();
  engine.translateMany = async (texts) => {
    const ok = new Map();
    for (const t of texts) if (t !== 'Beta paragraph text') ok.set(t, '【译】' + t);
    return { ok };
  };
  const a = textNode('Alpha paragraph text');
  const b = textNode('Beta paragraph text');
  const { got, failed } = await run([[a, a.data], [b, b.data]], { engine });
  assert.deepEqual(got.map(([n]) => n), [a]);
  assert.deepEqual(failed, [b]);
});

test('缓存命中不再发请求', async () => {
  const engine = fakeEngine();
  const cache = new TranslateCache({ limit: 100 });
  cache.set('Alpha paragraph text', '【译】Alpha paragraph text', 'zh-CN', 'mock');
  const a = textNode('Alpha paragraph text');
  const q = new TranslateQueue({ engine, cache, onResult: () => {}, onFail: () => {} });
  q.push(a, a.data);
  await q.drain();
  assert.equal(engine.calls.length, 0);
  assert.equal(q.stats.cacheHits, 1);
});

test('批次按 batchSize 切分，超大页面不会攒成一个巨型请求', async () => {
  const engine = fakeEngine();
  const items = [];
  for (let i = 0; i < 320; i++) { const n = textNode('Text number ' + i); items.push([n, n.data]); }
  const { cache } = { cache: null };
  const got = [];
  const q = new TranslateQueue({ engine, cache: new TranslateCache({ limit: 10 }), batchSize: 150, onResult: (n) => got.push(n), onFail: () => {} });
  for (const [n, t] of items) q.push(n, t);
  await q.drain();
  assert.equal(q.pending.size, 0);
  assert.equal(got.length, 320);
  assert.equal(engine.calls.length, 3); // 150 + 150 + 20
  assert.equal(engine.calls[0].length, 150);
});

test('已从文档摘除的节点直接丢弃，不写回', async () => {
  const a = textNode('Alpha paragraph text', false);
  const { got, engine } = await run([[a, a.data]]);
  assert.equal(got.length, 0);
  assert.equal(engine.calls.length, 0, '没有任何可写节点时不发请求');
});

test('push 同一节点两次只入队一次', async () => {
  const a = textNode('Alpha paragraph text');
  const engine = fakeEngine();
  const q = new TranslateQueue({ engine, cache: new TranslateCache({ limit: 10 }), onResult: () => {}, onFail: () => {} });
  assert.equal(q.push(a, a.data), true);
  assert.equal(q.push(a, a.data), false);
  assert.equal(q.size, 1);
  await q.drain();
});
