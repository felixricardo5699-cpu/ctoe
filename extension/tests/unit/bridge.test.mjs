// ---------- src/core/bridge.mjs 的单元测试 ----------
// 这里自带一个「假桌面端」：它按 ctoe 的协议说话（health / pair / learn / task），
// 但跑在本地随机端口上，所以测的是真实 HTTP 行为，而不是 mock 掉 fetch 后的空壳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  BRIDGE_MAX_TEXT_CHARS,
  BRIDGE_PROTOCOL_HEADER,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_COACH,
  bridgeErrorMessage,
  WAKE_URL,
  ensurePort,
  ensurePortWithWake,
  learnFromPage,
  learnSentence,
  pairBridge,
  readLanguageHint,
  probeBridge,
  sanitizeCoach
} from '../../src/core/bridge.mjs';

const TOKEN = 'a'.repeat(64);

// 假的桌面端：只实现协议本身，行为与 src/main/services/bridge 对齐
function startStubBridge(config = {}) {
  const { token = TOKEN, busy = false, settle = 'learned', protocol = BRIDGE_PROTOCOL_VERSION } = config;
  const tasks = new Map();
  const seen = { learn: 0, pair: 0, health: 0, bodies: [] };
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw.length ? JSON.parse(raw) : null; } catch (_e) { body = null; }
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '' });
        res.end(JSON.stringify(payload));
      };
      const path = String(req.url || '').split('?')[0];

      if (req.method === 'GET' && path === '/v1/health') {
        seen.health += 1;
        return send(200, { ok: true, protocol, app: 'ctoe', version: '0.1.0', busy });
      }

      const auth = String(req.headers.authorization || '');
      const match = /^Bearer[ ]+(.+)$/i.exec(auth.trim());
      if (!match || match[1].trim() !== token) return send(401, { ok: false, error: 'unauthorized' });

      if (req.method === 'POST' && path === '/v1/pair') {
        seen.pair += 1;
        return send(200, { ok: true, protocol, version: '0.1.0' });
      }
      if (req.method === 'POST' && path === '/v1/learn') {
        seen.learn += 1;
        seen.bodies.push(body);
        if (!body || typeof body.requestId !== 'string' || !body.text) return send(400, { ok: false, error: 'bad-json' });
        if (String(body.text).length > BRIDGE_MAX_TEXT_CHARS) return send(400, { ok: false, error: 'text-too-long' });
        seq += 1;
        const taskId = 'task-' + seq;
        tasks.set(taskId, { state: settle === 'pending' ? 'pending' : settle });
        return send(202, { ok: true, taskId });
      }
      if (req.method === 'GET' && path.startsWith('/v1/task/')) {
        const task = tasks.get(path.slice('/v1/task/'.length));
        if (!task) return send(200, { ok: true, state: 'failed', sentenceId: null, pair: null, failure: 'not-found', label: null });
        if (task.state === 'pending') return send(200, { ok: true, state: 'pending', sentenceId: null, pair: null, failure: null, label: null });
        if (task.state === 'failed') return send(200, { ok: true, state: 'failed', sentenceId: null, pair: null, failure: 'translation-failed', label: null });
        if (task.state === 'superseded') return send(200, { ok: true, state: 'failed', sentenceId: null, pair: null, failure: 'superseded', label: null });
        return send(200, {
          ok: true, state: 'learned', sentenceId: 1, label: '#000001',
          pair: { nativeLanguage: 'zh', learningLanguage: 'en' }, failure: null
        });
      }
      return send(404, { ok: false, error: 'not-found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        seen,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

// 轮询测试不用真的等：wait 换成直接 resolve，now 用可控时钟推进
const fastWait = () => Promise.resolve();

test('probeBridge 找到桌面端并报出协议版本', async () => {
  const stub = await startStubBridge();
  try {
    const found = await probeBridge({ ports: [stub.port] });
    assert.equal(found.listening, true);
    assert.equal(found.port, stub.port);
    assert.equal(found.protocol, BRIDGE_PROTOCOL_VERSION);
    assert.equal(found.appVersion, '0.1.0');
  } finally { await stub.close(); }
});

test('桌面端没启动时探测只是「没找到」，不抛异常', async () => {
  const stub = await startStubBridge();
  const deadPort = stub.port;
  await stub.close();
  const found = await probeBridge({ ports: [deadPort] });
  assert.equal(found.listening, false);
  assert.equal(found.port, null);
  assert.equal(found.protocol, null);
});

test('探测会按顺序跳过没人的端口', async () => {
  const stub = await startStubBridge();
  try {
    const found = await probeBridge({ ports: [43999, stub.port] });
    assert.equal(found.listening, true);
    assert.equal(found.port, stub.port);
  } finally { await stub.close(); }
});

test('端口不是 ctoe 时不认（别的程序占着这个端口）', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const found = await probeBridge({ ports: [port] });
    assert.equal(found.listening, false);
  } finally {
    await new Promise((done) => server.close(() => done()));
  }
});

test('配对：口令正确则通过', async () => {
  const stub = await startStubBridge();
  try {
    const res = await pairBridge({ token: TOKEN, port: stub.port });
    assert.equal(res.ok, true);
    assert.equal(res.protocol, BRIDGE_PROTOCOL_VERSION);
  } finally { await stub.close(); }
});

test('配对：口令错误时报 unauthorized 且不泄露路由细节', async () => {
  const stub = await startStubBridge();
  try {
    const res = await pairBridge({ token: 'wrong-token', port: stub.port });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
    assert.match(res.message, /口令/);
  } finally { await stub.close(); }
});

test('配对：空口令在本地就被拦下，不发请求', async () => {
  const stub = await startStubBridge();
  try {
    const res = await pairBridge({ token: '   ', port: stub.port });
    assert.equal(res.ok, false);
    assert.equal(stub.seen.pair, 0);
  } finally { await stub.close(); }
});

test('Learn：完整流程拿到 #000001 与语言对', async () => {
  const stub = await startStubBridge();
  try {
    const res = await learnSentence({
      port: stub.port, token: TOKEN, text: 'I did not expect things to turn out this way.',
      wait: fastWait, pollMs: 1, timeoutMs: 5000
    });
    assert.equal(res.ok, true);
    assert.equal(res.state, 'learned');
    assert.equal(res.sentenceId, 1);
    assert.equal(res.label, '#000001');
    assert.deepEqual(res.pair, { nativeLanguage: 'zh', learningLanguage: 'en' });
  } finally { await stub.close(); }
});

test('Learn：请求体带协议头与 Bearer 口令，并带上来源信息', async () => {
  const stub = await startStubBridge();
  try {
    await learnSentence({
      port: stub.port, token: TOKEN, text: 'hello world',
      url: 'https://example.com/a?b=1', title: 'Example', langHint: 'EN-us', mode: 'understand',
      requestId: 'req-1', wait: fastWait, pollMs: 1, timeoutMs: 5000
    });
    const body = stub.seen.bodies[0];
    assert.equal(body.requestId, 'req-1');
    assert.equal(body.text, 'hello world');
    assert.equal(body.mode, 'understand');
    assert.equal(body.langHint, 'en');
    assert.equal(body.url, 'https://example.com/a?b=1');
    assert.equal(body.title, 'Example');
  } finally { await stub.close(); }
});

test('Learn：langHint 是垃圾值时直接不发（不猜语言）', async () => {
  const stub = await startStubBridge();
  try {
    // 注意：'en-US' 这类是合法 BCP-47，会被读成 'en' 发出去——那不是垃圾值
    for (const junk of ['klingon', 'x', 'e', 'abcdefg', '', '  ', '123', '-']) {
      await learnSentence({ port: stub.port, token: TOKEN, text: 'hi', langHint: junk, wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    }
    for (const body of stub.seen.bodies) assert.equal('langHint' in body, false);
  } finally { await stub.close(); }
});

test('readLanguageHint：真实 lang 标签读成主语言子标签', async () => {
  assert.equal(readLanguageHint('en-US'), 'en');
  assert.equal(readLanguageHint('EN'), 'en');
  assert.equal(readLanguageHint('zh-Hans'), 'zh');
  assert.equal(readLanguageHint('zh_TW'), 'zh');
  assert.equal(readLanguageHint('ara'), 'ara');
  assert.equal(readLanguageHint(' fr '), 'fr');
  assert.equal(readLanguageHint('klingon'), null);
  assert.equal(readLanguageHint('x'), null);
  assert.equal(readLanguageHint(undefined), null);
  assert.equal(readLanguageHint(42), null);
});

test('Learn：客户端忽略非法 mode', async () => {
  const stub = await startStubBridge();
  try {
    await learnSentence({ port: stub.port, token: TOKEN, text: 'hi', mode: 'hack', wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal('mode' in stub.seen.bodies[0], false);
  } finally { await stub.close(); }
});

test('Learn：空文本不发请求', async () => {
  const stub = await startStubBridge();
  try {
    const res = await learnSentence({ port: stub.port, token: TOKEN, text: '   ', wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'empty-text');
    assert.equal(stub.seen.learn, 0);
  } finally { await stub.close(); }
});

test('Learn：超长文本在本地就被拦下', async () => {
  const stub = await startStubBridge();
  try {
    const res = await learnSentence({ port: stub.port, token: TOKEN, text: 'x'.repeat(BRIDGE_MAX_TEXT_CHARS + 1), wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal(res.error, 'text-too-long');
    assert.equal(stub.seen.learn, 0);
  } finally { await stub.close(); }
});

test('Learn：桌面端一直 pending 时超时，而不是永远挂着', async () => {
  const stub = await startStubBridge({ settle: 'pending' });
  try {
    let clock = 0;
    const res = await learnSentence({
      port: stub.port, token: TOKEN, text: 'hi',
      wait: () => { clock += 40000; return Promise.resolve(); },
      now: () => clock, timeoutMs: 60000
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, 'timeout');
  } finally { await stub.close(); }
});

test('Learn：桌面端说 failed 时把错误码翻成人话', async () => {
  const stub = await startStubBridge({ settle: 'failed' });
  try {
    const res = await learnSentence({ port: stub.port, token: TOKEN, text: 'hi', wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'translation-failed');
    assert.equal(res.message, bridgeErrorMessage('translation-failed'));
  } finally { await stub.close(); }
});

test('Learn：被更新的请求替换时能说明原因', async () => {
  const stub = await startStubBridge({ settle: 'superseded' });
  try {
    const res = await learnSentence({ port: stub.port, token: TOKEN, text: 'hi', wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal(res.error, 'superseded');
    assert.match(res.message, /替换/);
  } finally { await stub.close(); }
});

test('Learn：口令不对时不会把内容发出去', async () => {
  const stub = await startStubBridge();
  try {
    const res = await learnSentence({ port: stub.port, token: 'nope', text: 'hi', wait: fastWait, pollMs: 1, timeoutMs: 5000 });
    assert.equal(res.error, 'unauthorized');
    assert.equal(stub.seen.learn, 0);
  } finally { await stub.close(); }
});

test('ensurePort 复用记住的端口，不再全量扫描', async () => {
  const stub = await startStubBridge();
  try {
    const found = await ensurePort({ enabled: true, token: TOKEN, port: stub.port }, { ports: [43998] });
    assert.equal(found.listening, true);
    assert.equal(found.port, stub.port);
    assert.equal(stub.seen.health, 1);
  } finally { await stub.close(); }
});

test('ensurePort 记住的端口失效后回退到扫描', async () => {
  const stub = await startStubBridge();
  try {
    const found = await ensurePort({ enabled: true, token: TOKEN, port: 43997 }, { ports: [43997, stub.port] });
    assert.equal(found.listening, true);
    assert.equal(found.port, stub.port);
  } finally { await stub.close(); }
});

test('learnFromPage：没配对时给出可操作的一句话', async () => {
  const res = await learnFromPage({ enabled: true, token: '', port: 0 }, { text: 'hi' }, { ports: [43996] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthorized');
  assert.match(res.message, /配对/);
});

test('learnFromPage：用户关掉浏览器连接时直接拒绝（连端口都不碰）', async () => {
  const res = await learnFromPage({ enabled: false, token: TOKEN, port: 0 }, { text: 'hi' }, { ports: [43995] });
  assert.equal(res.error, 'bridge-off');
  assert.match(res.message, /关闭/);
});

test('learnFromPage：桌面端没启动时提示去启动', async () => {
  const res = await learnFromPage({ enabled: true, token: TOKEN, port: 0 }, { text: 'hi' }, { ports: [43994] });
  assert.equal(res.error, 'bridge-off');
  assert.match(res.message, /启动/);
});

test('learnFromPage：已配对时走完整个流程', async () => {
  const stub = await startStubBridge();
  try {
    const res = await learnFromPage(
      { enabled: true, token: TOKEN, port: stub.port },
      { text: 'I have been working here for five years.', langHint: 'en', url: 'https://example.com' },
      { ports: [stub.port], wait: fastWait, pollMs: 1, timeoutMs: 5000 }
    );
    assert.equal(res.ok, true);
    assert.equal(res.label, '#000001');
  } finally { await stub.close(); }
});

test('sanitizeCoach 兜住脏数据', async () => {
  assert.deepEqual(sanitizeCoach(undefined), { enabled: true, token: '', port: 0 });
  assert.deepEqual(sanitizeCoach({ enabled: false, token: '  abc  ', port: 43110 }), { enabled: false, token: 'abc', port: 43110 });
  assert.equal(sanitizeCoach({ port: -1 }).port, 0);
  assert.equal(sanitizeCoach({ port: 70000 }).port, 0);
  assert.equal(sanitizeCoach({ port: 'x' }).port, 0);
  assert.equal(sanitizeCoach({ token: 42 }).token, '');
  assert.equal(sanitizeCoach({ token: 'z'.repeat(500) }).token.length, 256);
  assert.deepEqual(DEFAULT_COACH, { enabled: true, token: '', port: 0 });
});

test('bridgeErrorMessage 认识桌面端所有错误码，未知码也不吞', async () => {
  const codes = ['unauthorized', 'bridge-off', 'protocol-too-new', 'empty-text', 'text-too-long', 'bad-json',
    'not-found', 'superseded', 'storage-failed', 'language-pair-id-exhausted', 'translation-failed', 'internal'];
  for (const code of codes) {
    const message = bridgeErrorMessage(code);
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0);
    assert.equal(message.includes(code), false, code + ' 不该把技术码暴露给用户');
  }
  assert.match(bridgeErrorMessage('language-pair-id-exhausted'), /编号/);
  assert.match(bridgeErrorMessage('what-is-this'), /what-is-this/);
  assert.equal(bridgeErrorMessage(undefined), '学习失败，请稍后重试。');
});

test('协议版本号与桌面端一致', async () => {
  assert.equal(BRIDGE_PROTOCOL_VERSION, 1);
  assert.equal(BRIDGE_PROTOCOL_HEADER, 'x-ctoe-protocol');
});

// ---------- 冷启动：门铃 → 等它起来 → 重试 ----------

test('门铃只负责唤醒：URL 里没有句子、没有口令、没有语言', async () => {
  assert.equal(WAKE_URL, 'ctoe://wake');
  assert.equal(WAKE_URL.includes('?'), false);
  assert.equal(WAKE_URL.includes('='), false);
});

test('冷启动：探测不到时点一次门铃，桌面端起来之后连上', async () => {
  const ports = [];
  const stubs = [];
  let clock = 0;
  try {
    const found = await ensurePortWithWake(
      { enabled: true, token: TOKEN, port: 0 },
      {
        ports,
        wake: async () => { const s = await startStubBridge(); stubs.push(s); ports.push(s.port); return true; },
        wait: () => { clock += 1000; return Promise.resolve(); },
        now: () => clock,
        waitForMs: 5000
      }
    );
    assert.equal(found.listening, true);
    assert.equal(found.woke, true);
  } finally { for (const s of stubs) await s.close(); }
});

test('冷启动：既没有门铃也没有等待预算时，只探一次就走，不多等', async () => {
  let waited = 0;
  const found = await ensurePortWithWake(
    { enabled: true, token: TOKEN, port: 0 },
    { ports: [43990], wait: () => { waited += 1; return Promise.resolve(); } }
  );
  assert.equal(found.listening, false);
  assert.equal(found.woke, false);
  assert.equal(waited, 0);
});

test('冷启动：门铃没点着（比如没有手势）时不再傻等', async () => {
  let waited = 0;
  const found = await ensurePortWithWake(
    { enabled: true, token: TOKEN, port: 0 },
    { ports: [43989], wake: async () => false, wait: () => { waited += 1; return Promise.resolve(); } }
  );
  assert.equal(found.listening, false);
  assert.equal(found.woke, false);
  assert.equal(waited, 0);
});

test('冷启动：等满预算仍然没起来时如实返回 woke=true', async () => {
  let clock = 0;
  const found = await ensurePortWithWake(
    { enabled: true, token: TOKEN, port: 0 },
    { ports: [43988], wake: async () => true, wait: () => { clock += 1000; return Promise.resolve(); }, now: () => clock, waitForMs: 3000 }
  );
  assert.equal(found.listening, false);
  assert.equal(found.woke, true);
});

test('发送阶段：桌面端临时连不上会重试，而不是直接失败', async () => {
  const stub = await startStubBridge();
  let failures = 1;
  const flaky = (url, init) => {
    if (failures > 0) { failures -= 1; return Promise.reject(new TypeError('fetch failed')); }
    return fetch(url, init);
  };
  try {
    const res = await learnSentence({
      port: stub.port, token: TOKEN, text: 'hi', fetchImpl: flaky,
      wait: fastWait, pollMs: 1, retryMs: 4000, timeoutMs: 5000
    });
    assert.equal(res.ok, true);
    assert.equal(res.label, '#000001');
    assert.equal(stub.seen.learn, 1);
  } finally { await stub.close(); }
});

test('发送阶段：口令不对是「回答」，不重试（只发一次）', async () => {
  const stub = await startStubBridge();
  let calls = 0;
  const counting = (url, init) => { calls += 1; return fetch(url, init); };
  try {
    const res = await learnSentence({
      port: stub.port, token: 'nope', text: 'hi', fetchImpl: counting,
      wait: fastWait, pollMs: 1, retryMs: 4000, timeoutMs: 5000
    });
    assert.equal(res.error, 'unauthorized');
    assert.equal(calls, 1);
    assert.equal(stub.seen.learn, 0);
  } finally { await stub.close(); }
});

test('learnFromPage：连不上时给出 reason=not-listening（内容脚本据此去点门铃）', async () => {
  const res = await learnFromPage({ enabled: true, token: TOKEN, port: 0 }, { text: 'hi' }, { ports: [43987] });
  assert.equal(res.error, 'bridge-off');
  assert.equal(res.reason, 'not-listening');
  assert.equal(res.woke, false);
  assert.match(res.message, /启动/);
  assert.match(res.message, /浏览器连接/);
});

test('learnFromPage：未配对与「用户关掉了」各有自己的 reason，不会和「没启动」混为一谈', async () => {
  const unpaired = await learnFromPage({ enabled: true, token: '', port: 0 }, { text: 'hi' }, { ports: [43986] });
  const off = await learnFromPage({ enabled: false, token: TOKEN, port: 0 }, { text: 'hi' }, { ports: [43985] });
  assert.equal(unpaired.reason, 'unpaired');
  assert.equal(off.reason, 'disabled');
});

test('learnFromPage：桌面端已经在跑时不去点门铃（不打扰用户）', async () => {
  const stub = await startStubBridge();
  let wokeCount = 0;
  try {
    const res = await learnFromPage(
      { enabled: true, token: TOKEN, port: stub.port },
      { text: 'hi' },
      { ports: [stub.port], wake: async () => { wokeCount += 1; return true; }, wait: fastWait, pollMs: 1, timeoutMs: 5000 }
    );
    assert.equal(res.ok, true);
    assert.equal(wokeCount, 0);
  } finally { await stub.close(); }
});

test('learnFromPage：带 wake 时从冷启动一路走到 #000001', async () => {
  const ports = [];
  const stubs = [];
  let wokeCount = 0;
  let clock = 0;
  try {
    const res = await learnFromPage(
      { enabled: true, token: TOKEN, port: 0 },
      { text: 'I have been working here for five years.' },
      {
        ports,
        wake: async () => { wokeCount += 1; const s = await startStubBridge(); stubs.push(s); ports.push(s.port); return true; },
        wait: () => { clock += 1000; return Promise.resolve(); },
        now: () => clock,
        waitForMs: 5000,
        pollMs: 1
      }
    );
    assert.equal(res.ok, true);
    assert.equal(res.label, '#000001');
    assert.equal(wokeCount, 1);
  } finally { for (const s of stubs) await s.close(); }
});

test('冷启动：唤起之后端口出现，但请求半路连不上时会重试（reason=lost-desktop）', async () => {
  const stub = await startStubBridge();
  const port = stub.port;
  await stub.close();
  let calls = 0;
  const halfDead = async () => { calls += 1; throw new TypeError('fetch failed'); };
  const res = await learnSentence({
    port, token: TOKEN, text: 'hi', fetchImpl: halfDead,
    wait: fastWait, pollMs: 1, retryMs: 4000, timeoutMs: 5000
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'lost-desktop');
  assert.ok(calls >= 2, '应当重试过：' + calls);
});
