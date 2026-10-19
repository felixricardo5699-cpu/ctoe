// ---------- 翻译引擎：Google / Edge / custom / mock，自动降级（记忆最快引擎 + 快速失败切换） ----------
import { chunkText, normalizeSpace, hashText } from './text.mjs';

export class EngineError extends Error {
  constructor(message, { retriable = true, provider = null, cause } = {}) {
    super(message);
    this.name = 'EngineError';
    this.retriable = retriable;
    this.provider = provider;
    this.cause = cause;
  }
}

const DEFAULTS = {
  baseUrls: {
    google: 'https://translate.googleapis.com',
    // Edge 公共免费端点：微软已下线旧的 api-edge…+/translate（需要 auth token）流程，新版无需鉴权
    edge: 'https://edge.microsoft.com'
  },
  concurrency: 3,
    retry: 2,
    timeoutMs: 8000,
    chunkChars: 1300,
    jitterMs: [50, 200]
  };

// 批量翻译：一次请求带多条文本。免费端点单请求开销大（每条文本一个 RTT），
// 一条条发是整页翻译慢的主因，这里把同一批文本合并成一次请求。
// 单请求上限：32 条 / 3000 字符（Google 走 query string，留出 URL 与百分号编码的余量）。
const BATCH_MAX_TEXTS = 32;
const BATCH_MAX_CHARS = 3000;

async function fetchWithTimeout(url, init = {}, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.text()).slice(0, 300); } catch (_) {}
      throw new EngineError(`HTTP ${res.status} ${res.statusText} ${msg}`, {
        retriable: res.status === 429 || res.status >= 500
      });
    }
    return res;
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (e && e.name === 'AbortError') throw new EngineError('timeout', { retriable: true });
    throw new EngineError(`network: ${e && e.message ? e.message : String(e)}`, { retriable: true, cause: e });
  } finally {
    clearTimeout(timer);
  }
}

export function buildGoogleUrl(base, q, sl, tl) {
  const u = new URL(base.replace(/\/+$/, '') + '/translate_a/single');
  u.searchParams.set('client', 'gtx');
  u.searchParams.set('sl', sl || 'auto');
  u.searchParams.set('tl', tl || 'zh-CN');
  u.searchParams.set('dt', 't');
  u.searchParams.set('q', q);
  return u.toString();
}

export function parseGoogleGtx(json) {
  const det = parseGoogleGtxDetailed(json);
  if (det && det.text) return det.text;
  throw new EngineError('google: 无法解析响应', { retriable: false, provider: 'google' });
}

/**
 * 解析 gtx 响应，同时保留每个「句子分组」的原文（orig）。
 * 批量翻译时用它校验行边界：只有 orig 与请求原文逐字一致，拆分才可信。
 */
export function parseGoogleGtxDetailed(json) {
  if (Array.isArray(json) && Array.isArray(json[0])) {
    const groups = [];
    let text = '';
    for (const group of json[0]) {
      if (Array.isArray(group) && typeof group[0] === 'string') {
        const trans = group[0];
        const orig = typeof group[1] === 'string' ? group[1] : '';
        groups.push({ trans, orig });
        text += trans;
      } else if (group && typeof group === 'object' && typeof group.translatedText === 'string') {
        groups.push({ trans: group.translatedText, orig: typeof group.originalText === 'string' ? group.originalText : '' });
        text += group.translatedText;
      }
    }
    if (text) return { text, groups };
  }
  if (json && typeof json === 'object') {
    const s = json.sentences || (Array.isArray(json.translatedText) ? json.translatedText : null);
    if (Array.isArray(s)) {
      const groups = s.map((x) => {
        if (typeof x === 'string') return { trans: x, orig: '' };
        return { trans: (x && x.trans) || '', orig: (x && (x.orig || x.originalText)) || '' };
      });
      return { text: groups.map((g) => g.trans).join(''), groups };
    }
    if (typeof json.translatedText === 'string') return { text: json.translatedText, groups: [{ trans: json.translatedText, orig: '' }] };
  }
  return null;
}

// Edge 公共端点不接受 zh-CN/zh-TW 区域后缀：zh-CN → zh-Hans、zh-TW → zh-Hant
export function edgeTargetLang(tl) {
  if (tl === 'zh-CN') return 'zh-Hans';
  if (tl === 'zh-TW') return 'zh-Hant';
  return tl || 'zh-Hans';
}

export function buildEdgeUrl(base, sl, tl) {
  const u = new URL(base.replace(/\/+$/, '') + '/translate/translatetext');
  // 老版本默认配置指向 api-edge…+/translate + auth token，微软已下线该流程；仍配置旧地址时自动纠正
  if (u.hostname === 'api-edge.cognitive.microsofttranslator.com') u.hostname = 'edge.microsoft.com';
  u.searchParams.set('to', edgeTargetLang(tl));
  if (sl && sl !== 'auto') u.searchParams.set('from', sl);
  u.searchParams.set('isEnterpriseClient', 'false');
  return u.toString();
}

export function parseEdgeMs(json) {
  if (Array.isArray(json) && json[0] && json[0].translations && Array.isArray(json[0].translations)) {
    return json[0].translations.map((t) => t.text).join('');
  }
  if (json && Array.isArray(json.translations)) return json.translations.map((t) => t.text).join('');
  if (json && typeof json === 'object' && typeof json.text === 'string') return json.text;
  throw new EngineError('edge: 无法解析响应', { retriable: false, provider: 'edge' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把待翻译文本按条数/字符数打包成批量请求 */
export function packBatches(texts, maxTexts = BATCH_MAX_TEXTS, maxChars = BATCH_MAX_CHARS) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= maxTexts || n + t.length + 1 > maxChars)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(t);
    n += t.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 用响应里每个句子分组的原文（orig）校验行边界，再把整段译文切回每条文本。
 * 只有当「原文逐字一致」且「每个 \n 都正好落在句子分组边界上」时才认为拆分可信，
 * 否则返回 null，调用方退回逐条翻译 —— 宁可多花一次请求，也不能把译文错位。
 */
export function splitBatchByOrig(groups, texts) {
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(texts) || texts.length < 2) return null;
  const strip = (s) => String(s).replace(/[\r\n]/g, '');
  let acc = '';
  const sizes = [];
  for (const g of groups) {
    if (!g || typeof g.trans !== 'string' || typeof g.orig !== 'string') return null;
    const o = strip(g.orig);
    acc += o;
    sizes.push(o.length);
  }
  if (acc !== texts.join('')) return null; // 原文必须逐字一致（只忽略作为分隔符的换行）
  const boundaries = new Set();
  let cum = 0;
  for (const n of sizes) { cum += n; boundaries.add(cum); }
  const cuts = new Set();
  let off = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    off += texts[i].length;
    if (!boundaries.has(off)) return null; // 行分隔符没落在句子分组边界上 → 不可信，退回逐条
    cuts.add(off);
  }
  const outs = new Array(texts.length).fill('');
  let line = 0;
  off = 0;
  for (let i = 0; i < groups.length; i++) {
    outs[line] += groups[i].trans;
    off += sizes[i];
    if (cuts.has(off) && line < texts.length - 1) line++;
  }
  return outs;
}

export class TranslateEngine {
  constructor(settings = {}) {
    this.opts = {
      ...DEFAULTS,
      ...(settings.opts || {})
    };
    this.opts.baseUrls = { ...DEFAULTS.baseUrls, ...(settings.baseUrls || {}) };
    this.chain = (settings.providerChain && settings.providerChain.length ? settings.providerChain : ['google', 'edge']);
    this.sl = settings.sourceLang || 'auto';
    this.tl = settings.targetLang || 'zh-CN';
    this.custom = settings.customApi || {};
    this.inflight = new Map();
    this.stats = { requests: 0, chars: 0, failures: 0, providerHits: {} };
    // 运行期引擎健康状态：preferred=最近成功引擎；pstate=失败计数/熔断截止；probe=首请求并发探测
    this._preferred = null;
    this._pstate = new Map();
    this._probeStarted = false;
    this._probePromise = null;
    this._batchOff = new Map(); // provider -> 连续无法对齐次数（达到阈值后本会话不再尝试批量）
  }

  get _timeout() { return this.opts.timeoutMs; }

  /** 缓存指纹里代表「引擎组合」的标签（同一组合才复用译文） */
  get cacheTag() { return this.chain.join('+'); }

  /** 选项页改动后热更新（并发/重试/抖动） */
  applyOptions(opts = {}) {
    if (!opts) return;
    for (const k of ['concurrency', 'retry', 'jitterMs', 'timeoutMs', 'chunkChars']) {
      if (opts[k] !== undefined && opts[k] !== null) this.opts[k] = opts[k];
    }
  }

  _maxConcurrency() {
    const n = Number(this.opts.concurrency);
    return Math.max(1, Math.min(16, Number.isFinite(n) && n > 0 ? Math.trunc(n) : 3));
  }

  /** 抖动区间：支持 [min,max] / 数字 / 关闭 */
  _jitterRange() {
    const j = this.opts.jitterMs;
    if (Array.isArray(j)) {
      const lo = Math.max(0, Number(j[0]) || 0);
      const hi = Math.max(lo, Number(j[1]) || lo);
      return [lo, hi];
    }
    const v = Math.max(0, Number(j) || 0);
    return [v, v];
  }

  /**
   * 全局请求闸门：并发上限 + 随机抖动。
   * 整页翻译会瞬间产生几十个请求，同一秒全打给免费端点很容易被判风控（429），
   * 因此所有出口请求（Google/Edge/custom/mock）都必须经过这里排队。
   */
  async _fetch(url, init = {}, timeoutMs) {
    if (!this._gate) this._gate = { active: 0, queue: [] };
    const gate = this._gate;
    if (gate.active >= this._maxConcurrency()) {
      await new Promise((resolve) => gate.queue.push(resolve));
    }
    gate.active++;
    try {
      const [lo, hi] = this._jitterRange();
      if (hi > 0) await sleep(lo + Math.random() * (hi - lo));
      return await fetchWithTimeout(url, init, timeoutMs || this._timeout);
    } finally {
      gate.active--;
      const next = gate.queue.shift();
      if (next) next();
    }
  }

  // 仅“纯免费引擎链”(google+edge)启用并发探测与记忆最快引擎；
  // 链中含 custom/mock 等时保持用户指定顺序，避免探测改动付费/自定义引擎的实际使用顺序
  get _adaptive() {
    return this.chain.length > 1 && this.chain.every((p) => p === 'google' || p === 'edge');
  }

  async _googleOne(text) {
    const url = buildGoogleUrl(this.opts.baseUrls.google, text, this.sl, this.tl);
    const res = await this._fetch(url, { method: 'GET' });
    return parseGoogleGtx(await res.json());
  }

  // 记录引擎失败：连续失败达到阈值后临时熔断，避免每条文本都耗在已失效引擎上
  _noteFailure(provider, err) {
    if (!provider) return;
    const st = this._pstate.get(provider) || { fails: 0, until: 0 };
    st.fails++;
    const severe = !!(err && (err.cause || (err instanceof EngineError && (/^timeout$|^network:/i.test(err.message || '')))));
    if (st.fails >= (severe ? 2 : 3)) {
      st.until = Date.now() + (severe ? 30000 : 15000);
      st.fails = 0;
    }
    this._pstate.set(provider, st);
    if (provider === this._preferred) this._preferred = null;
  }

  _isCooled(provider) {
    const st = this._pstate.get(provider);
    return !!(st && st.until > Date.now());
  }

  // 尝试顺序：最近成功的引擎优先，其余按 providerChain 顺序（熔断跳过/全部熔断探活由调用处处理）
  _attemptOrder() {
    const pref = this._preferred && this.chain.includes(this._preferred) && !this._isCooled(this._preferred) ? this._preferred : null;
    return pref ? [pref, ...this.chain.filter((p) => p !== pref)] : this.chain;
  }

  // 首个请求并发探测所有引擎：最快返回有效译文者成为本会话首选。
  // 落败/超时的请求在后台自行结束（含各自超时），不阻塞本次返回
  _probeFirst(text) {
    return new Promise((resolve, reject) => {
      let pending = this.chain.length;
      let won = false;
      let firstErr = null;
      const win = (provider, out) => {
        if (won) return;
        won = true;
        this._preferred = provider;
        resolve(String(out).trim());
      };
      const fail = (err) => {
        if (won) return;
        if (!firstErr) firstErr = err;
        if (--pending === 0) reject(firstErr || new EngineError('翻译失败'));
      };
      for (const provider of this.chain) {
        this._callProvider(provider, text)
          .then((out) => {
            const norm = out == null ? '' : String(out).trim();
            if (norm) win(provider, out);
            else {
              this._noteFailure(provider, new EngineError(provider + ': 空译文', { retriable: true }));
              fail(firstErr || new EngineError(provider + ': 空译文', { retriable: true }));
            }
          })
          .catch((e) => {
            this._noteFailure(provider, e);
            fail(e);
          });
      }
    });
  }

  async _edgeOne(text) {
    // Edge 公共免费端点（无鉴权）：POST …/translate/translatetext，请求体为裸 JSON 字符串数组
    const url = buildEdgeUrl(this.opts.baseUrls.edge, this.sl, this.tl);
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([text])
    });
    return parseEdgeMs(await res.json());
  }

  async _customOne(text) {
    const api = this.custom;
    if (!api || !api.endpoint) throw new EngineError('custom: 未配置', { retriable: false, provider: 'custom' });
    const headers = { 'Content-Type': 'application/json', ...(api.headers || {}) };
    if (api.apiKey) headers.Authorization = `Bearer ${api.apiKey}`;
    const fmt = api.format || 'json';
    if (fmt === 'openai') {
      const body = {
        model: api.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: `Translate to ${this.tl} (output the translation only):\n\n${text}` }],
        temperature: 0.2
      };
        const res = await this._fetch(api.endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, Math.max(this._timeout, 20000));
        const json = await res.json();
      const msg = json?.choices?.[0]?.message?.content;
      if (typeof msg !== 'string') throw new EngineError('custom: bad openai response', { retriable: false, provider: 'custom' });
      return msg.trim();
    }
      const res = await this._fetch(api.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: text, text, texts: [text], source: this.sl, target: this.tl })
      }, Math.max(this._timeout, 15000));
      const json = await res.json();
    if (json && typeof json === 'object') {
      if (typeof json.translatedText === 'string') return json.translatedText;
      if (typeof json.text === 'string') return json.text;
      const arr = Array.isArray(json.translations) ? json.translations : Array.isArray(json.texts) ? json.texts : null;
      if (arr && typeof arr[0] === 'string') return arr[0];
      if (arr && arr[0] && typeof arr[0].text === 'string') return arr[0].text;
    }
    throw new EngineError('custom: bad response', { retriable: false, provider: 'custom' });
  }

  async _mockOne(text) {
    const base = this.opts.baseUrls.mock;
    if (!base) throw new EngineError('mock: 未配置 baseUrls.mock', { retriable: false, provider: 'mock' });
    const u = new URL(base.replace(/\/+$/, '') + '/mock');
    u.searchParams.set('q', text);
    u.searchParams.set('target', this.tl);
      const res = await this._fetch(u.toString(), { method: 'GET' });
      const json = await res.json();
    if (typeof json.translatedText === 'string') return json.translatedText;
    if (typeof json.text === 'string') return json.text;
    throw new EngineError('mock bad', { retriable: false, provider: 'mock' });
  }

  async _callProvider(provider, text) {
    if (provider === 'google') return this._googleOne(text);
    if (provider === 'edge') return this._edgeOne(text);
    if (provider === 'custom') return this._customOne(text);
    if (provider === 'mock') return this._mockOne(text);
    throw new EngineError(`未知引擎 ${provider}`, { retriable: false });
  }

  async _translateOneText(text) {
    const t0 = Date.now();
    let lastErr = null;
    let probeOwner = false;
    let probePromise = null;
    // 非自适应链（含 custom 等）：严格按用户指定顺序；自适应纯免费链则先做一次并发探测
    if (this._adaptive && !this._probeStarted) {
      // 引擎首个文本：并发探测一次，确定后续首选引擎（详见 _probeFirst）
      this._probeStarted = true;
      probeOwner = true;
      probePromise = this._probeFirst(text);
      this._probePromise = probePromise;
    } else if (this._adaptive && this._probePromise) {
      // 其余并发请求：等探测结果确定首选引擎后再开始，避免整批文本都先打在失效引擎上
      try { await this._probePromise; } catch (_) {}
    }
    if (probeOwner) {
      try {
        const out = await (probePromise || this._probePromise);
        const norm = out == null ? '' : String(out).trim();
        if (norm) {
          this.stats.requests++;
          this.stats.chars += text.length;
          const provider = this._preferred;
          if (provider) this.stats.providerHits[provider] = (this.stats.providerHits[provider] || 0) + 1;
          return norm;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    // 常规轮询：自适应链首选(上次成功)优先、失效即快速切换；各引擎失败会临时熔断，轮间仅保留极小的退避
    const rounds = Math.max(1, (this.opts.retry || 0) + 1);
    for (let round = 0; round < rounds; round++) {
      const baseOrder = round === 0 && this._adaptive ? this._attemptOrder() : this.chain;
      if (round > 0) await sleep(60);
      // 熔断中的引擎在有可用候选时跳过；全部熔断则仍硬试一轮做探活，便于故障恢复后自动接续
      const live = baseOrder.filter((p) => !this._isCooled(p));
      const order = live.length ? live : baseOrder;
      let hardStop = false;
      for (const provider of order) {
        try {
          const out = await this._callProvider(provider, text);
          const norm = out == null ? '' : String(out).trim();
          if (!norm) throw new EngineError(`${provider}: 空译文`, { retriable: true });
          this._pstate.delete(provider);
          if (this._adaptive) this._preferred = provider;
          this.stats.requests++;
          this.stats.chars += text.length;
          this.stats.providerHits[provider] = (this.stats.providerHits[provider] || 0) + 1;
          return norm;
        } catch (e) {
          lastErr = e;
          this.stats.failures++;
          if (e && e.retriable === false) { hardStop = true; break; }
          this._noteFailure(provider, e);
        }
      }
      if (hardStop) break;
    }
    if (this.opts.debug && Date.now() - t0 > 2500) console.warn('[ot] slow/fail', text.slice(0, 60), lastErr && lastErr.message);
    throw lastErr || new EngineError('翻译失败');
  }

  /** 该引擎是否支持一次请求多条文本（mock/custom 保持逐条，顺序与计费语义不变） */
  _batchable(provider) {
    if (provider !== 'google' && provider !== 'edge') return false;
    return (this._batchOff.get(provider) || 0) < 3;
  }

  _noteBatchMiss(provider) {
    const n = (this._batchOff.get(provider) || 0) + 1;
    this._batchOff.set(provider, n);
  }

  _noteBatchSuccess(provider, texts) {
    this._pstate.delete(provider);
    if (this._adaptive) this._preferred = provider;
    if (!this._probeStarted) { this._probeStarted = true; this._probePromise = null; } // 批量已证明可用，无需再探测
    this.stats.requests++;
    this.stats.chars += texts.reduce((n, t) => n + t.length, 0);
    this.stats.providerHits[provider] = (this.stats.providerHits[provider] || 0) + 1;
  }

  async _googleBatch(texts) {
    const url = buildGoogleUrl(this.opts.baseUrls.google, texts.join('\n'), this.sl, this.tl);
    const res = await this._fetch(url, { method: 'GET' });
    const det = parseGoogleGtxDetailed(await res.json());
    if (!det || !det.text) throw new EngineError('google: 无法解析响应', { retriable: false, provider: 'google' });
    return splitBatchByOrig(det.groups, texts); // null = 行边界无法确认，本次退回逐条
  }

  async _edgeBatch(texts) {
    const url = buildEdgeUrl(this.opts.baseUrls.edge, this.sl, this.tl);
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(texts)
    });
    const json = await res.json();
    const arr = Array.isArray(json) ? json : null;
    if (!arr || arr.length !== texts.length) throw new EngineError('edge: 批量返回条数不符', { retriable: true, provider: 'edge' });
    return arr.map((item) => {
      if (item && Array.isArray(item.translations) && item.translations[0] && typeof item.translations[0].text === 'string') return item.translations[0].text;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    });
  }

  /** 一次批量请求；返回 null 表示「该引擎批量结果不可信」，调用方退回逐条 */
  async _providerBatch(provider, texts) {
    if (provider === 'google') return this._googleBatch(texts);
    if (provider === 'edge') return this._edgeBatch(texts);
    return null;
  }

  async _runBatch(list, ok) {
    const order = this._adaptive ? this._attemptOrder() : this.chain;
    const live = order.filter((p) => !this._isCooled(p));
    const seq = live.length ? live : order;
    // 优先级最高的引擎不支持批量时保持逐条语义（用户显式指定的顺序不能被批量改写）
    if (!seq.length || !this._batchable(seq[0])) return;
    const tryOrder = seq.filter((p) => this._batchable(p));
    for (const provider of tryOrder) {
      try {
        const outs = await this._providerBatch(provider, list);
        if (!outs) { this._noteBatchMiss(provider); return; }
        if (outs.length === list.length && outs.every((x) => typeof x === 'string' && x.trim())) {
          this._noteBatchSuccess(provider, list);
          for (let i = 0; i < list.length; i++) ok.set(list[i], outs[i].trim());
          return;
        }
        this._noteFailure(provider, new EngineError(provider + ': 批量结果不完整', { retriable: true, provider }));
      } catch (e) {
        this._noteFailure(provider, e);
      }
    }
  }

  /** 逐条翻译（保留探测、熔断、逐条降级等既有语义），并复用并发中的相同文本请求 */
  async _oneSettled(text, ok, fail) {
    if (this.inflight.has(text)) {
      try { const v = await this.inflight.get(text); if (v != null) ok.set(text, v); else fail.add(text); }
      catch (_) { fail.add(text); }
      return;
    }
    const task = (async () => {
      const pieces = chunkText(text, this.opts.chunkChars);
      const res = [];
      for (const piece of pieces) res.push(await this._translateOneText(piece));
      return res.join('');
    })();
    this.inflight.set(text, task);
    try { ok.set(text, await task); } catch (_) { fail.add(text); } finally { this.inflight.delete(text); }
  }

  /**
   * 两阶段翻译：
   *   1) 批量阶段 —— 把多条文本合并成少量请求（受引擎支持时），请求数直接决定整页耗时；
   *   2) 逐条阶段 —— 批量未覆盖/失败/超长的文本按并发上限逐条翻译（自动降级、熔断、探测都在这里）。
   */
  async translateMany(uniqueTexts, { signal } = {}) {
    const texts = [...new Set(uniqueTexts.filter((t) => typeof t === 'string' && t.trim()))];
    const ok = new Map();
    const fail = new Set();
    const waits = [];
    const todo = [];
    for (const t of texts) {
      if (this.inflight.has(t)) waits.push(this._oneSettled(t, ok, fail));
      else todo.push(t);
    }
    if (todo.length) {
      const mergeable = todo.filter((t) => t.indexOf('\n') < 0);
      const batches = packBatches(mergeable).filter((b) => b.length > 1);
      if (batches.length) {
        const idx = { i: 0 };
        const bn = Math.min(4, batches.length);
        const batchWorker = async () => {
          while (true) {
            const i = idx.i++;
            if (i >= batches.length) return;
            if (signal && signal.aborted) return;
            await this._runBatch(batches[i], ok);
          }
        };
        await Promise.all(Array.from({ length: bn }, batchWorker));
      }
      const rest = todo.filter((t) => !ok.has(t));
      if (rest.length) {
        const idx2 = { i: 0 };
        const n = Math.min(this.opts.concurrency, rest.length);
        const worker = async () => {
          while (true) {
            if (signal && signal.aborted) return;
            const i = idx2.i++;
            if (i >= rest.length) return;
            await this._oneSettled(rest[i], ok, fail);
          }
        };
        await Promise.all(Array.from({ length: n }, worker));
      }
    }
    await Promise.all(waits);
    return { ok, fail };
  }
}

export function engineCacheKey(text, tl, provider) {
  return `${tl}|${provider}|${hashText(normalizeSpace(text))}`;
}
