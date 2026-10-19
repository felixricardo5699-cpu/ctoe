import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseGoogleGtx, parseGoogleGtxDetailed, parseEdgeMs, buildGoogleUrl, buildEdgeUrl, packBatches, splitBatchByOrig, TranslateEngine } from '../../src/core/engines.mjs';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../src/core/settings.mjs';

test('parseGoogleGtx 解析典型响应', () => {
  const fixture = [[['你好', 'Hello', null, null, 10]], null, 'en', null, null];
  assert.equal(parseGoogleGtx(fixture), '你好');
  const multi = [[['第一句。', 'Sentence one.', null, null, 10], ['第二句。', 'Sentence two.', null, null, 10]], null, 'en'];
  assert.equal(parseGoogleGtx(multi), '第一句。第二句。');
  assert.throws(() => parseGoogleGtx({ foo: 1 }));
});

test('parseEdgeMs 解析 Microsoft 响应', () => {
  const fixture = [{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '你好' }] }];
  assert.equal(parseEdgeMs(fixture), '你好');
});

test('URL 构造带参数编码', () => {
  const u = buildGoogleUrl('https://translate.googleapis.com', 'a & b', 'auto', 'zh-CN');
  assert.ok(u.includes('client=gtx') && u.includes('sl=auto') && u.includes('tl=zh-CN'));
  assert.ok(u.includes('q=a') && u.includes('%26'));
  const e = buildEdgeUrl('https://x.test', 'en', 'zh-CN');
  assert.ok(e.includes('/translate/translatetext'));
  assert.ok(e.includes('to=zh-Hans') && e.includes('from=en') && e.includes('isEnterpriseClient=false'));
  assert.ok(!e.includes('api-version'));
  assert.ok(buildEdgeUrl('https://x.test', 'auto', 'zh-TW').includes('to=zh-Hant'));
  // 老配置里残留的 api-edge 地址自动纠正到新版公共端点
  assert.ok(buildEdgeUrl('https://api-edge.cognitive.microsofttranslator.com', 'en', 'zh-CN').startsWith('https://edge.microsoft.com/translate/translatetext'));
});

test('Edge 公共端点全链路：无鉴权 POST，请求体为裸字符串数组', async () => {
  const seen = { url: '', method: '', auth: null, body: '' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/translate/translatetext') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.url = u.search;
        seen.method = req.method;
        seen.auth = req.headers.authorization || null;
        seen.body = body;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ translations: [{ text: '你好，世界' }] }]));
      });
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['edge'],
      sourceLang: 'en',
      targetLang: 'zh-CN',
      baseUrls: { edge: `http://127.0.0.1:${port}` }
    });
    const { ok } = await eng.translateMany(['Hello world']);
    assert.equal(ok.get('Hello world'), '你好，世界');
    assert.equal(seen.method, 'POST');
    assert.ok(seen.url.includes('to=zh-Hans') && seen.url.includes('from=en') && seen.url.includes('isEnterpriseClient=false'));
    assert.equal(seen.auth, null);
    assert.deepEqual(JSON.parse(seen.body), ['Hello world']);
  } finally {
    server.close();
  }
});

test('引擎自动降级：探测后记住可用引擎，后续文本跳过失效引擎', async () => {
  let googleHits = 0;
  let edgeHits = 0;
  const edgeBodies = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/translate_a/single') { googleHits++; res.statusCode = 500; res.end('boom'); return; }
    if (u.pathname === '/translate/translatetext') {
      edgeHits++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const texts = JSON.parse(body || '[]');
        edgeBodies.push(texts);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(texts.map((q) => ({ translations: [{ text: '【译】' + q }] }))));
      });
      return;
    }
    if (u.pathname === '/mock') {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['google', 'edge'],
      sourceLang: 'auto',
      targetLang: 'zh-CN',
      baseUrls: { google: `http://127.0.0.1:${port}`, edge: `http://127.0.0.1:${port}` }
    });
    const texts = ['Alpha beta', 'Gamma delta'];
    const { ok, fail } = await eng.translateMany(texts);
    assert.equal(fail.size, 0);
    assert.equal(ok.get('Alpha beta'), '【译】Alpha beta');
    assert.equal(ok.get('Gamma delta'), '【译】Gamma delta');
    assert.equal(googleHits, 1); // 失效的 google 只在批量阶段被试探一次
    assert.equal(edgeHits, 1);   // 两条文本合并成一次批量请求（旧实现是 2 次）
    assert.deepEqual(edgeBodies, [['Alpha beta', 'Gamma delta']]);
  } finally {
    server.close();
  }
});

test('批量打包：按条数与字符数切分，不丢文本', () => {
  // 默认上限：32 条 / 3000 字符（单批次控制在 3000~5000 字符量级）
  const def = packBatches(Array.from({ length: 100 }, (_, i) => 'text number ' + i));
  assert.ok(def.every((b) => b.length <= 32 && b.join('\n').length <= 3000));
  const texts = Array.from({ length: 40 }, (_, i) => 'text number ' + i);
  const batches = packBatches(texts, 16, 1500);
  assert.deepEqual(batches.flat(), texts);
  assert.ok(batches.every((b) => b.length <= 16 && b.join('\n').length <= 1500));
  const long = ['x'.repeat(1400), 'y'.repeat(200), 'z'.repeat(50)];
  const b2 = packBatches(long, 16, 1500);
  assert.deepEqual(b2.flat(), long);
  assert.ok(b2.every((b) => b.join('\n').length <= 1500));
});

test('批量结果按 orig 校验行边界后才拆分（对不齐必须拒绝）', () => {
  // 引擎把每行当作一个句子分组返回：分隔符正好落在分组边界 → 可信
  const groupsOk = [
    { trans: '你好', orig: 'Hello' },
    { trans: '世界', orig: 'World' },
    { trans: '再见', orig: 'Bye' }
  ];
  assert.deepEqual(splitBatchByOrig(groupsOk, ['Hello', 'World', 'Bye']), ['你好', '世界', '再见']);
  // 第一行两句被合并进同一分组：分隔符落在分组内部 → 拒绝（退回逐条，绝不猜着切）
  const groupsMerged = [
    { trans: '你好世界', orig: 'Hello\nWorld' },
    { trans: '再见', orig: 'Bye' }
  ];
  assert.equal(splitBatchByOrig(groupsMerged, ['Hello', 'World', 'Bye']), null);
  // 原文被引擎改写（少了个空格）→ 拒绝
  assert.equal(splitBatchByOrig([{ trans: 'x', orig: 'Hello' }, { trans: 'y', orig: 'World!' }], ['Hello', 'World']), null);
  // 句子分组内换行位置不同（换行挂在分组里）不影响边界判定
  const groupsSplit = [
    { trans: '你好。', orig: 'Hello.\n' },
    { trans: '世界。', orig: 'World.' }
  ];
  assert.deepEqual(splitBatchByOrig(groupsSplit, ['Hello.', 'World.']), ['你好。', '世界。']);
  // 一行被拆成多个句子分组：仍归并到同一行
  assert.deepEqual(splitBatchByOrig([
    { trans: '甲', orig: 'One.' },
    { trans: '乙', orig: ' Two.' },
    { trans: '丙', orig: 'Three.' }
  ], ['One. Two.', 'Three.']), ['甲乙', '丙']);
  // 空分组 / 缺失原文 → 拒绝
  assert.equal(splitBatchByOrig([{ trans: 'a', orig: 'One' }], ['One', 'Two']), null);
  assert.equal(splitBatchByOrig([], ['One']), null);
});

test('parseGoogleGtxDetailed 保留每个句子分组的原文', () => {
  const det = parseGoogleGtxDetailed([[['你好', 'Hello', null, null, 10], ['世界', 'World', null, null, 10]], null, 'en']);
  assert.equal(det.text, '你好世界');
  assert.deepEqual(det.groups, [{ trans: '你好', orig: 'Hello' }, { trans: '世界', orig: 'World' }]);
  assert.equal(parseGoogleGtxDetailed({ foo: 1 }), null);
});

test('非纯免费链（含 mock/custom）保持用户指定顺序、不做并发探测', async () => {
  let googleHits = 0;
  let mockHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/translate_a/single') { googleHits++; res.statusCode = 500; res.end('boom'); return; }
    if (u.pathname === '/mock') {
      mockHits++;
      const q = u.searchParams.get('q') || '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ translatedText: '【译】' + q }));
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['mock', 'google'],
      baseUrls: { google: `http://127.0.0.1:${port}`, mock: `http://127.0.0.1:${port}` }
    });
    const texts = ['Alpha beta', 'Gamma delta'];
    const { ok } = await eng.translateMany(texts);
    assert.equal(ok.get('Alpha beta'), '【译】Alpha beta');
    assert.equal(ok.get('Gamma delta'), '【译】Gamma delta');
    assert.equal(mockHits, 2);
    assert.equal(googleHits, 0); // 用户指定 mock 优先且可用，不触发探测/调整
  } finally {
    server.close();
  }
});

test('sanitizeSettings 合并/兜底', () => {
  const s = sanitizeSettings({ targetLang: 'xx-bad', providerChain: ['bogus'], concurrency: 99 });
  assert.equal(s.targetLang, 'zh-CN');
  assert.deepEqual(s.providerChain, []);
  assert.ok(s.concurrency <= 16);
});

test('TranslateEngine mock 全链路（本地 HTTP）', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/mock') {
      const q = u.searchParams.get('q') || '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ translatedText: '【译】' + q }));
    } else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['mock'],
      targetLang: 'zh-CN',
      baseUrls: { mock: `http://127.0.0.1:${port}` }
    });
    const texts = ['Hello world', 'Good morning', 'Hello world'];
    const { ok, fail } = await eng.translateMany(texts);
    assert.equal(ok.size, 2); // 去重
    assert.equal(fail.size, 0);
    assert.equal(ok.get('Hello world'), '【译】Hello world');
  } finally {
    server.close();
  }
});

test('引擎自动降级：首个引擎失败后使用第二个', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/translate_a/single') { res.statusCode = 500; res.end('boom'); }
    else if (u.pathname === '/mock') { res.end(JSON.stringify({ translatedText: '降级成功' })); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['google', 'mock'],
      targetLang: 'zh-CN',
      baseUrls: { google: `http://127.0.0.1:${port}`, mock: `http://127.0.0.1:${port}` }
    });
    const { ok } = await eng.translateMany(['test text']);
    assert.equal(ok.get('test text'), '降级成功');
  } finally { server.close(); }
});

test('请求队列：全局并发不超过上限，且请求起点带随机抖动（防风控）', async () => {
  let active = 0;
  let peak = 0;
  let hits = 0;
  const starts = [];
  const server = http.createServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    hits++;
    starts.push(Date.now());
    setTimeout(() => {
      active--;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ translatedText: '【译】ok' }));
    }, 40);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const eng = new TranslateEngine({
      providerChain: ['mock'],
      targetLang: 'zh-CN',
      baseUrls: { mock: base },
      opts: { concurrency: 3, retry: 0, jitterMs: [30, 60], timeoutMs: 5000 }
    });
    const texts = Array.from({ length: 9 }, (_, i) => 'translate me number ' + i);
    const { ok } = await eng.translateMany(texts);
    assert.equal(ok.size, 9);
    assert.equal(hits, 9);
    assert.ok(peak <= 3, '并发峰值必须受控 peak=' + peak);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]).sort((a, b) => a - b);
    assert.ok(gaps[gaps.length - 1] >= 25, '请求起点应被抖动拉开 gaps=' + JSON.stringify(gaps));
  } finally {
    server.close();
  }
});

test('请求抖动可用 jitterMs:[0,0] 关闭（自动化测试）', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ translatedText: '【译】fast' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const eng = new TranslateEngine({ providerChain: ['mock'], targetLang: 'zh-CN', baseUrls: { mock: base }, opts: { concurrency: 4, retry: 0, jitterMs: [0, 0] } });
    const t0 = Date.now();
    const { ok } = await eng.translateMany(['one', 'two', 'three', 'four']);
    assert.equal(ok.size, 4);
    assert.equal(hits, 4);
    assert.ok(Date.now() - t0 < 1000, 'ms=' + (Date.now() - t0));
  } finally {
    server.close();
  }
});

test('DEFAULT_SETTINGS 结构完整', () => {
  const s = sanitizeSettings(DEFAULT_SETTINGS);
  assert.ok(s.providerChain.includes('google'));
  assert.equal(s.mode, 'replace');
});
