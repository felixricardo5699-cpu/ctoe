// ---------- AI Language Coach 桌面端桥接客户端 ----------
// 职责：把「用户在网页上看到的一句话」交给本机的 AI Language Coach 应用去 Learn。
//
// 三条硬约束（与桌面端 src/shared/types/bridge.ts 的协议一致，改协议要两边一起改）：
//   1. 扩展从不说「哪两个语言」——那是桌面端用户档案的事，扩展最多给一个 langHint。
//   2. 只有用户主动点击才发送；不自动、不后台、不记录网页内容。
//   3. 本模块不碰 chrome.*、不碰 DOM、不碰 setInterval：端口、fetch、等待全从参数进来，
//      所以它可以被单元测试直接驱动（tests/unit/bridge.test.mjs）。

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT_FIRST = 43110;
export const BRIDGE_PORT_LAST = 43119;
export const BRIDGE_PORTS = Object.freeze(
  Array.from({ length: BRIDGE_PORT_LAST - BRIDGE_PORT_FIRST + 1 }, (_unused, i) => BRIDGE_PORT_FIRST + i)
);

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_PROTOCOL_HEADER = 'x-ctoe-protocol';

// 桌面端输入框的上限，客户端先拦一次，省一次往返
export const BRIDGE_MAX_TEXT_CHARS = 8000;

export const BRIDGE_PROBE_TIMEOUT_MS = 1500;
export const BRIDGE_LEARN_TIMEOUT_MS = 20000;
export const BRIDGE_TASK_POLL_MS = 1200;
export const BRIDGE_TASK_TIMEOUT_MS = 120000;

// ---------- 冷启动：门铃 ----------
// 桌面端没在跑的时候，HTTP 是没有意义的——没有东西在监听。唯一能把它叫起来的是 ctoe:// 门铃。
//
// 门铃只负责唤醒，绝不携带任何东西：URL 里不写句子、不写口令、不写语言。自定义协议的链接谁都能
// 触发（网页里一行 location.href 就够了），所以它能做的只有「把窗口叫到前面」；句子始终走带口令的
// 回环桥接。桌面端那边也只把命令行当成一个布尔值读（src/main/services/bridge/doorbell.ts）。
//
// 这个模块仍然不碰 DOM、不碰 chrome.*：点门铃要用 DOM 或标签页 API，由调用方通过 wake 注入，
// 所以「唤醒 → 等它起来 → 重试」整条链都能被单测驱动。
export const WAKE_URL = 'ctoe://wake';

// 点完门铃先等一拍再探：进程启动、加载、开端口都要时间，立刻探只会白探一次。
export const BRIDGE_WAKE_SETTLE_MS = 1200;
// 从点门铃到端口开始监听的等待上限。冷启动实测 1~3 秒，20 秒足够宽裕，
// 又不至于让用户对着「正在打开桌面端，最多等 20 秒…」干等。
export const BRIDGE_WAKE_TIMEOUT_MS = 20000;
// 等待期间的重探间隔。
export const BRIDGE_WAKE_PROBE_MS = 1000;
// 唤起之前那一次「你到底在不在」的探测预算。必须短：这一刻正处在用户点击的手势窗口里
// （浏览器只允许手势触发的 ctoe:// 唤起），最坏情况 11 个端口 × 300ms 也要留在窗口内。
export const BRIDGE_PREWAKE_PROBE_TIMEOUT_MS = 300;

// POST 的传输层重试预算：探测到端口之后、请求真正发出去之前，桌面端可能刚好退出或被关掉。
// 只重试「没连上」，绝不重试协议级的回答——401/400/202 都是回答，重试多少次都一样。
export const BRIDGE_SEND_RETRY_MS = 4000;

// 与桌面端 BRIDGE_MODES 一致，只是扩展侧的一个提示，不是指令：
// 'understand' = 这句话用的是「正在学的语言」，我想读懂；
// 'express'    = 这句话用的是「我自己的语言」，我想说出正在学的那门。
export const BRIDGE_MODES = Object.freeze(['understand', 'express']);


// 短语种最少、最稳定的一份：只有真正带 token 的请求才会被拒，未配对时探测只会看到 health。
export const DEFAULT_COACH = Object.freeze({ enabled: true, token: '', port: 0 });

export function sanitizeCoach(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const token = typeof src.token === 'string' ? src.token.trim() : '';
  const port = Number(src.port);
  return {
    enabled: src.enabled !== false,
    token: token.slice(0, 256),
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0
  };
}

// 桌面端的错误码 → 用户能看懂的一句话。带 token 的失败原因都在这里，
// 所以「口令错了」和「没开浏览器连接」不会长成同一个样子。
const ERROR_MESSAGES = Object.freeze({
  unauthorized: '连接口令不正确，请在桌面端「设置 → 浏览器连接」重新复制。',
  'bridge-off': '桌面端没有开启浏览器连接，请在「设置 → 浏览器连接」中打开。',
  'protocol-too-new': '桌面端版本过旧，请升级 AI Language Coach。',
  'empty-text': '没有可学习的文本。',
  'text-too-long': '这段文字太长了，选中一句话再试。',
  'bad-json': '请求格式不正确。',
  'not-found': '没有找到这次学习任务（可能已过期）。',
  superseded: '有更新的学习请求，这一次被替换了。',
  'storage-failed': '桌面端保存失败，请检查磁盘空间后重试。',
  'language-pair-id-exhausted': '该语言对的学习编号已用尽，请在桌面端新建语言对。',
  'translation-failed': '桌面端翻译失败，请检查网络后重试。',
  internal: '桌面端处理失败，请稍后重试。'
});

export function bridgeErrorMessage(code) {
  if (typeof code !== 'string' || code.length === 0) return '学习失败，请稍后重试。';
  return ERROR_MESSAGES[code] || '学习失败（' + code + '）。';
}

export function makeRequestId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_e) { /* 退化到时间戳 */ }
  return 'ot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// BCP-47 的主语言子标签：en / zh / fr / ar ... 也就 2~3 个字母
const LANGUAGE_TAG = /^[a-z]{2,3}$/;

/**
 * 把页面的 lang 属性读成主语言子标签（'en-US' -> 'en'，'zh_Hans' -> 'zh'），读不出来就是 null。
 *
 * 只做形状校验，不查语言表：该不该教这门语言是桌面端的判断，它不认识的 hint 会自己忽略。
 * 这里拦掉的只是垃圾值——lang="x"、lang="klingon" 这类，扩展宁可什么都不说，也不猜语言。
 */
export function readLanguageHint(value) {
  const primary = normalizeText(value).toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_TAG.test(primary) ? primary : null;
}

/**
 * 一次桥接请求。永远不抛：连不上、超时、响应不是 JSON 都收成 { ok:false }，
 * 因为「桌面端没开」是这个功能最常见的正常情况，不是异常。
 */
export async function bridgeFetch(options) {
  const {
    port,
    path,
    method = 'GET',
    token = '',
    body,
    fetchImpl = fetch,
    timeoutMs = BRIDGE_PROBE_TIMEOUT_MS
  } = options;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, status: 0, data: null, error: 'no-port' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { [BRIDGE_PROTOCOL_HEADER]: String(BRIDGE_PROTOCOL_VERSION) };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl('http://' + BRIDGE_HOST + ':' + port + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await res.json(); } catch (_e) { data = null; }
    return { ok: res.ok, status: res.status, data, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e && e.name) === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按端口范围找桌面端。/v1/health 是唯一免口令的路由，所以未配对也能先问「在不在」。
 * 桌面端关闭浏览器连接时端口根本不在监听，因此探测失败就是「没开」，不是错误。
 */
export async function probeBridge(options = {}) {
  const ports = options.ports || BRIDGE_PORTS;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || BRIDGE_PROBE_TIMEOUT_MS;
  for (const port of ports) {
    const res = await bridgeFetch({ port, path: '/v1/health', fetchImpl, timeoutMs });
    const data = res.data;
    if (res.ok && data && data.ok === true && data.app === 'ctoe') {
      return {
        listening: true,
        port,
        protocol: typeof data.protocol === 'number' ? data.protocol : null,
        appVersion: typeof data.version === 'string' ? data.version : null,
        busy: data.busy === true
      };
    }
  }
  return { listening: false, port: null, protocol: null, appVersion: null, busy: false };
}

/**
 * 优先复用已记住的端口，探不通再全量扫一遍——桌面端可能这次绑到了另一个端口。
 */
export async function ensurePort(coach, options = {}) {
  const saved = coach && Number.isInteger(coach.port) ? coach.port : 0;
  if (saved > 0) {
    const res = await bridgeFetch({
      port: saved,
      path: '/v1/health',
      fetchImpl: options.fetchImpl || fetch,
      timeoutMs: options.timeoutMs || BRIDGE_PROBE_TIMEOUT_MS
    });
    const data = res.data;
    if (res.ok && data && data.ok === true && data.app === 'ctoe') {
      return {
        listening: true,
        port: saved,
        protocol: typeof data.protocol === 'number' ? data.protocol : null,
        appVersion: typeof data.version === 'string' ? data.version : null,
        busy: data.busy === true
      };
    }
  }
  return probeBridge(options);
}

/**
 * 探测桌面端；探测不到时先点门铃，再等它起来。
 *
 * 两种用法，对应「谁手里有手势」这件事：
 *   - 内容脚本：传 wake（用 DOM 点 ctoe://）。用户那一次点击就是手势，浏览器才允许唤起外部程序；
 *   - Service Worker：不传 wake，只传 waitForMs —— 门铃已经由内容脚本点过了，这里只负责等端口出现。
 *
 * 两个都没给就退化成一次普通探测，不会多等一毫秒：「桌面端没开」是这个功能最常见的正常情况，
 * 不该让用户白等。返回的 woke 说明这次到底有没有去敲过门，UI 靠它决定说「正在启动」还是「请先启动」。
 */
export async function ensurePortWithWake(coach, options = {}) {
  const wait = options.wait || defaultWait;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const probeMs = Number.isFinite(options.wakeProbeMs) ? options.wakeProbeMs : BRIDGE_WAKE_PROBE_MS;
  const wake = options.wake;

  const found = await ensurePort(coach, options);
  if (found.listening) return { ...found, woke: false };

  let budget = Number.isFinite(options.waitForMs) ? options.waitForMs : 0;
  let woke = false;
  if (typeof wake === 'function') {
    try { woke = (await wake()) !== false; } catch (_e) { woke = false; }
    // 没点着（页面里没有 DOM、或浏览器把手势拦下了）就别等了：等也不会有东西起来。
    if (!woke) return { ...found, woke: false };
    if (budget <= 0) budget = BRIDGE_WAKE_TIMEOUT_MS;
    await wait(BRIDGE_WAKE_SETTLE_MS);
  }
  if (budget <= 0) return { ...found, woke };

  const deadline = now() + budget;
  while (now() < deadline) {
    const again = await ensurePort(coach, options);
    if (again.listening) return { ...again, woke };
    await wait(probeMs);
  }
  return { ...found, woke };
}

/** 用户把桌面端口令粘进来后的校验：能过就说明两边说的是同一件事。 */
export async function pairBridge(options) {
  const { token, port, fetchImpl = fetch, timeoutMs = BRIDGE_PROBE_TIMEOUT_MS } = options;
  const clean = typeof token === 'string' ? token.trim() : '';
  if (clean.length === 0) return { ok: false, error: 'unauthorized', message: bridgeErrorMessage('unauthorized') };
  const res = await bridgeFetch({ port, path: '/v1/pair', method: 'POST', token: clean, body: { token: clean }, fetchImpl, timeoutMs });
  const data = res.data;
  if (res.ok && data && data.ok === true) {
    return { ok: true, protocol: typeof data.protocol === 'number' ? data.protocol : null, appVersion: typeof data.version === 'string' ? data.version : null };
  }
  const code = data && typeof data.error === 'string' ? data.error : res.error === 'unreachable' ? 'bridge-off' : 'internal';
  return { ok: false, error: code, message: bridgeErrorMessage(code) };
}

function fail(code) {
  return { ok: false, state: 'failed', taskId: null, sentenceId: null, label: null, pair: null, error: code, message: bridgeErrorMessage(code) };
}

/**
 * Learn 一句：POST /v1/learn 拿到 taskId，然后轮询 /v1/task/:id 直到 learned / failed。
 *
 * 轮询是必需的：桌面端要翻译 + 让 AI 分析，可能几秒。桌面端同一时刻只跑一个任务，
 * 更新的请求会替换旧的（superseded），所以这里不做并发队列——用户点第二下时，第一下本来就该让位。
 */
export async function learnSentence(options) {
  const {
    port,
    token,
    mode,
    langHint,
    url,
    title,
    requestId,
    fetchImpl = fetch,
    wait = defaultWait,
    poll = true,
    pollMs = BRIDGE_TASK_POLL_MS,
    timeoutMs = BRIDGE_TASK_TIMEOUT_MS,
    retryMs = BRIDGE_SEND_RETRY_MS,
    now = Date.now
  } = options;

  const text = normalizeText(options.text);
  if (text.length === 0) return fail('empty-text');
  if (text.length > BRIDGE_MAX_TEXT_CHARS) return fail('text-too-long');

  const payload = { requestId: requestId || makeRequestId(), text };
  if (BRIDGE_MODES.includes(mode)) payload.mode = mode;
  const hint = readLanguageHint(langHint);
  if (hint !== null) payload.langHint = hint;
  const pageUrl = normalizeText(url);
  if (pageUrl) payload.url = pageUrl.slice(0, 2048);
  const pageTitle = normalizeText(title);
  if (pageTitle) payload.title = pageTitle.slice(0, 300);

  const send = () => bridgeFetch({
    port, path: '/v1/learn', method: 'POST', token, body: payload,
    fetchImpl, timeoutMs: BRIDGE_LEARN_TIMEOUT_MS
  });

  // 探测到端口之后、请求真正落地之前，桌面端仍可能刚好退出或被关掉。status 0 = 连都没连上，
  // 这是唯一值得重试的失败；协议级的拒绝（401/400）是桌面端的回答，重试多少次都是同一个回答。
  // 重试用的是同一个 requestId，所以即使第一次其实已经送达，桌面端的幂等窗口也只会入一条。
  const sendDeadline = now() + (Number.isFinite(retryMs) ? retryMs : 0);
  let accepted = await send();
  // 除了时间预算，还压一个尝试次数上限：注入的时钟可能不走（测试里 wait 不推进 now），
  // 只靠 deadline 判断会变成死循环。三次足够覆盖「桌面端正在启动」的常见情形。
  const maxAttempts = 3;
  let attempts = 1;
  while (accepted.status === 0 && attempts < maxAttempts && now() < sendDeadline) {
    attempts += 1;
    await wait(pollMs);
    accepted = await send();
  }

  const data = accepted.data;
  if (accepted.status !== 202 || !data || data.ok !== true || typeof data.taskId !== 'string') {
    const code = data && typeof data.error === 'string' ? data.error
      : accepted.error === 'unreachable' ? 'bridge-off'
      : accepted.error === 'timeout' ? 'internal' : 'internal';
    const out = fail(code);
    // 「连不上」和「桌面端拒绝了」必须分开：前者可以再叫一次门铃，后者叫多少次都一样。
    if (accepted.status === 0) out.reason = 'lost-desktop';
    return out;
  }

  const taskId = data.taskId;
  if (!poll) return { ok: true, state: 'pending', taskId, sentenceId: null, label: null, pair: null, error: null, message: null };

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await wait(pollMs);
    const polled = await bridgeFetch({
      port, path: '/v1/task/' + encodeURIComponent(taskId), token,
      fetchImpl, timeoutMs: BRIDGE_PROBE_TIMEOUT_MS
    });
    const task = polled.data;
    // 一次轮询失败（桌面端正忙/刚好重启）不该让整次学习失败，下一轮再问
    if (!polled.ok || !task || task.ok !== true) continue;
    if (task.state === 'learned') {
      return {
        ok: true,
        state: 'learned',
        taskId,
        sentenceId: typeof task.sentenceId === 'number' ? task.sentenceId : null,
        label: typeof task.label === 'string' ? task.label : null,
        pair: task.pair || null,
        error: null,
        message: null
      };
    }
    if (task.state === 'failed') {
      const code = typeof task.failure === 'string' ? task.failure : 'internal';
      return { ok: false, state: 'failed', taskId, sentenceId: null, label: null, pair: null, error: code, message: bridgeErrorMessage(code) };
    }
  }
  return {
    ok: false, state: 'timeout', taskId, sentenceId: null, label: null, pair: null,
    error: 'internal', message: '桌面端没有在预期时间内返回结果，请到 My Learning 查看。'
  };
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Service Worker 侧的一步包装：查设置 → 探端口（必要时唤一次门铃）→ 发送 → 轮询。
 * 放在这里而不是 SW 里，是为了让「未配对 / 未启动 / 已读不回」三条路都能被测试覆盖。
 */
export async function learnFromPage(coach, request, options = {}) {
  const settings = sanitizeCoach(coach);
  // reason 是给内容脚本看的，不是给用户看的：它决定「要不要去点门铃」和「要不要接着等」。
  // 桌面端自己的错误码（error）保持不变，两者不要混。
  if (!settings.enabled) {
    return { ok: false, state: 'failed', error: 'bridge-off', reason: 'disabled', message: '浏览器连接已关闭，可在扩展设置中打开。' };
  }
  if (settings.token.length === 0) {
    return { ok: false, state: 'failed', error: 'unauthorized', reason: 'unpaired', message: '还没有配对：请在扩展设置里粘贴桌面端口令。' };
  }
  const found = await ensurePortWithWake(settings, options);
  if (!found.listening) {
    // 从外面分不清「软件没启动」和「开关关着」——两种情况端口都不在监听，所以这句话要把两条路都说了。
    return {
      ok: false,
      state: 'failed',
      error: 'bridge-off',
      reason: 'not-listening',
      woke: found.woke === true,
      message: found.woke
        ? '已经唤起 AI Language Coach，但还没连上：请在弹出的提示里允许打开，并确认桌面端「设置 → 浏览器连接」里的开关是打开的。'
        : '没有检测到 AI Language Coach：请先启动桌面端，并在「设置 → 浏览器连接」里开启浏览器连接。'
    };
  }
  return learnSentence({
    port: found.port,
    token: settings.token,
    text: request.text,
    mode: request.mode,
    langHint: request.langHint,
    url: request.url,
    title: request.title,
    requestId: request.requestId,
    fetchImpl: options.fetchImpl || fetch,
    wait: options.wait,
    poll: options.poll,
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
    retryMs: options.retryMs,
    now: options.now
  });
}
