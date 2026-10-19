// ---------- 编排层：整页翻译状态机 ----------
// 数据流（所有网站共用同一条链路，没有任何站点特判）：
//
//   网页 DOM
//     -> ① 提取层   collectTextNodes(TreeWalker)      text-nodes.mjs
//     -> ② 过滤层   rules.mjs（标签/区域/可见性/文本语义）
//     -> ③ 合并层   Merge -> Translate -> Split       merge.mjs
//     -> ④ 翻译队列 TranslateQueue（攒批 + 去重）      queue.mjs
//     -> ⑤ 映射层   node[i] <- text[i] 的译文          queue.mjs
//     -> ⑥ 回写层   node.data = 译文（只动 TextNode）  writer.mjs
//     -> ⑦ MutationObserver 新增节点回到 ①            observer.mjs
//
// 单元粒度 = 一个 TextNode（③ 只决定「请求里发什么」，回写仍是一个节点一个片段）。
// 不做「容器 + 子节点区间」的整块抽取，所以两个帖子、两个商品标题永远不会被拼成
// 同一段文本，也不会被写进同一个节点。
import { TranslateEngine } from './engines.mjs';
import { TranslateCache } from './cache.mjs';
import { buildRules } from './rules.mjs';
import { collectTextNodes, isAllowedTextNode } from './text-nodes.mjs';
import { TextWriter } from './writer.mjs';
import { DomWatcher } from './observer.mjs';
import { TranslateQueue, QUEUE_BATCH } from './queue.mjs';

const CACHE_KEY = 'ot-cache-v3';
const QUIET_MS = 30000;      // 页面安静这么久且队列为空 → 兜底重扫暂停
const WATCH_SOON_MS = 1500;  // 页面正在变动时的兜底重扫间隔
const WATCH_IDLE_MS = 8000;  // 长时间安静后的兜底重扫间隔
const PRUNE_EVERY = 20;      // 每 N 轮兜底重扫回收一次内存

export class PageTranslator {
  constructor(ctx) {
    this.doc = ctx.doc;
    this.win = ctx.win;
    this.settings = ctx.settings;
    this.onStatus = ctx.onStatus || (() => {});
    this.cache = new TranslateCache({ persistKey: CACHE_KEY });
    this.engine = new TranslateEngine({
      providerChain: this.settings.providerChain,
      sourceLang: this.settings.sourceLang,
      targetLang: this.settings.targetLang,
      opts: this.engineOpts(this.settings),
      baseUrls: buildBaseUrls(this.settings.hostOverrides),
      customApi: this.settings.customApi || {}
    });
    this.mode = this.settings.mode === 'bilingual' ? 'bilingual' : 'replace';
    this.writer = new TextWriter({ mode: this.mode });
    this.enabled = false;
    this.stats = this._newStats();
    this.queue = new TranslateQueue({
      engine: this.engine,
      cache: this.cache,
      batchSize: QUEUE_BATCH,
      // 句级重建：把被行内标签切开的同一句话合并成一个单元翻译，再按片段切回各节点
      sentenceMerge: this.settings.sentenceMerge !== false,
      getRules: () => this._rules(),
      onResult: (node, text, opts) => this._onResult(node, text, opts),
      onFail: (node) => this._onFail(node)
    });
    this.watcher = new DomWatcher({
      doc: this.doc,
      isOurs: (node) => this.writer.isOurs(node),
      onChange: (batch) => this._onPageChange(batch)
    });
    this._queued = new WeakSet();     // 已入队的文本节点（防重复入队）
    this._failCount = new WeakMap();  // 文本节点 -> 连续失败次数（离线时不做无限重试）
    this._rulesCache = null;
    this._rulesLang = '';
    this._stopped = true;
    this._watchTimer = null;
    this._watchTicks = 0;
    this._lastMutationAt = 0;
    this._lastScanAt = 0;
    this.failedCount = 0;
    this.doneCount = 0;
    this._visHandler = () => {
      if (this.doc.visibilityState !== 'hidden' && this.enabled) this._scanSoon(0);
    };
  }

  _newStats() {
    return {
      scanned: 0,       // 遍历过的元素节点数
      textNodes: 0,     // 遍历过的文本节点数
      units: 0,         // 入队的翻译单元数（= 文本节点数）
      unitsDone: 0,     // 已回写的文本节点数
      requests: 0,      // 引擎层实际请求数
      mutations: 0,     // MutationObserver 回调次数
      shadowRoots: 0,   // 已接入的 open shadow root 数
      translates: 0     // 完成的翻译轮次
    };
  }

  engineOpts(s) {
    return {
      concurrency: s.concurrency,
      retry: s.retry,
      timeoutMs: 8000,
      jitterMs: s.requestJitterMs
    };
  }

  get debug() { return !!this.settings.debug; }

  _log(...args) { if (this.debug) console.info('[ot]', ...args); }

  get isEnabled() { return this.enabled; }

  get strategy() { return 'text-node'; }   // 兼容调试信息里的 strategy 字段

  async init() {
    try {
      const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
      await this.cache.attachStorage(store);
    } catch (_) {}
  }

  applySettings(next) {
    if (next) this.settings = next;
    this.engine.applyOptions(this.engineOpts(this.settings));
    this.engine.chain = this.settings.providerChain;
    this.engine.sl = this.settings.sourceLang;
    this.engine.tl = this.settings.targetLang;
    this._rulesCache = null; // 规则与设置绑定，设置变化后重建
    if (this.queue) {
      this.queue.sentenceMerge = this.settings.sentenceMerge !== false;
      this.queue.getRules = () => this._rules();
      this.queue.reset();      // 规则变了：丢掉待办与 solo 标记，按新规则重新扫描
    }
  }

  /** 显示方式切换：替换 / 双语（都是只动文本节点与属性，不需要刷新页面） */
  setMode(mode) {
    const next = mode === 'bilingual' ? 'bilingual' : 'replace';
    if (next === this.mode) return;
    this.mode = next;
    this.writer.setMode(next);
  }

  _rules() {
    const lang = this.settings.targetLang;
    if (!this._rulesCache || this._rulesLang !== lang) {
      this._rulesCache = buildRules(this.settings, lang);
      this._rulesLang = lang;
    }
    return this._rulesCache;
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    if (on) {
      this.enabled = true;
      this._stopped = false;
      this.failedCount = 0;
      this.doneCount = 0;
      this.stats = this._newStats();
      this._queued = new WeakSet();
      this._failCount = new WeakMap();
      this._rulesCache = null;
      this.queue.reset();
      this._lastMutationAt = Date.now();
      this._lastScanAt = 0;
      this.applySettings(this.settings);
      this.watcher.start();
      this._scanRoots([this.doc.body]);
      this.doc.addEventListener('visibilitychange', this._visHandler, { passive: true });
      this._startWatch();
      this._status();
    } else {
      this.enabled = false;
      this._stopped = true;
      this.watcher.stop();
      this._stopWatch();
      this.doc.removeEventListener('visibilitychange', this._visHandler);
      this.queue.clear();
      const restored = this.writer.restoreAll();  // 逐文本节点还原原文，无需刷新页面
      this._log('已还原原文', restored);
      this._status();
    }
  }

  /** 扫描一批根节点（新增子树 / document.body） */
  _scanRoots(roots) {
    if (!this.enabled || !roots || !roots.length) return 0;
    const rules = this._rules();
    let found = 0;
    for (const root of roots) {
      if (!root) continue;
      if (root.nodeType === 3) {
        if (this._acceptTextNode(root, rules)) found++;
        continue;
      }
      if (!root.isConnected) continue;
      let nodes = [];
      try {
        nodes = collectTextNodes(root, rules, {
          stats: this.stats,
          isSkippedText: (n) => this._queued.has(n) || this.writer.isOurs(n),
          onShadowRoot: (sr) => this.watcher.observeNode(sr)
        });
      } catch (e) { this._log('扫描异常', e && e.message); }
      for (const node of nodes) if (this._acceptTextNode(node, rules)) found++;
    }
    this._lastScanAt = Date.now();
    this.stats.shadowRoots = this.watcher.shadowCount;
    if (found) { this.stats.units += found; this._drain(); }
    return found;
  }

  _acceptTextNode(node, rules) {
    if (!node || node.nodeType !== 3 || !node.isConnected) return false;
    if (this._queued.has(node)) return false;
    if (this.writer.isOurs(node)) return false;      // 已是我们写进去的译文
    const text = node.data;
    if (!rules) rules = this._rules();
    if (!isAllowedTextNode(node, rules)) return false;
    this._queued.add(node);
    this.queue.push(node, text);
    return true;
  }

  /** MutationObserver 回调：新增子树走 TreeWalker，原位改写的文本节点直接重译 */
  _onPageChange(batch) {
    if (!this.enabled) return;
    this._lastMutationAt = Date.now();
    this.stats.mutations = this.watcher.stats.mutations;
    const rules = this._rules();
    for (const t of batch.texts) this._acceptTextNode(t, rules);
    if (batch.roots.length) this._scanRoots(batch.roots);
    this._drain();
    this._status();
  }

  _onResult(node, translated, opts) {
    const ok = this.writer.write(node, translated, opts);
    if (ok) {
      this.stats.unitsDone++;
      this.doneCount++;
      this._failCount.delete(node);
    } else {
      this.failedCount++;
      this._queued.delete(node);
    }
    this._queued.delete(node);
  }

  /**
   * 单条翻译失败：失败 1 次就放回重试（网络抖动很常见），连续 2 次仍失败则保持「已入队」状态
   * 不再重试 —— 离线时不会陷入「失败 → 重扫 → 再失败」的死循环。
   */
  _onFail(node) {
    this.failedCount++;
    const n = (this._failCount.get(node) || 0) + 1;
    this._failCount.set(node, n);
    if (n < 2 && node && node.isConnected && !this.writer.isOurs(node)) this._queued.delete(node);
  }

  _drain() {
    if (!this.enabled) return;
    const p = this.queue.drain();
    p.then(() => {
      if (!this.enabled) return;
      this.stats.translates++;
      if (this._watchTicks % PRUNE_EVERY === 0) this.writer.prune();
      this._status();
    // 兜底：批次异常绝不允许静默消失（否则整页会「看起来没反应」而没有任何线索）
    }).catch((e) => this._log('翻译回路异常', e && e.message));
  }

  // ---- 兜底重扫：只补漏网的动态内容（attachShadow 晚于扫描、被中断的遍历等） ----
  _startWatch() {
    if (this._watchTimer) return;
    this._watchTimer = setTimeout(() => this._watchTick(), WATCH_SOON_MS);
  }

  _stopWatch() {
    if (this._watchTimer) { clearTimeout(this._watchTimer); this._watchTimer = null; }
  }

  _watchTick() {
    this._watchTimer = null;
    if (!this.enabled || this._stopped) return;
    this._watchTicks++;
    const hidden = this.doc.visibilityState === 'hidden';
    const idle = Date.now() - this._lastMutationAt;
    const quiet = idle > QUIET_MS && !this.queue.size;
    if (!hidden && !quiet && this.doc.body) this._scanRoots([this.doc.body]);
    this._watchTimer = setTimeout(() => this._watchTick(), idle < 3000 ? WATCH_SOON_MS : WATCH_IDLE_MS);
  }

  _status(extra = {}) {
    const q = this.queue.stats;
    this.onStatus({
      phase: this.enabled ? (this.queue.size ? 'translating' : 'done') : 'idle',
      enabled: this.enabled,
      pending: this.queue.size,
      done: this.doneCount,
      failed: this.failedCount,
      strategy: this.strategy,
      lastScan: this._lastScanAt,
      shadowRoots: this.watcher.shadowCount,
      stats: {
        ...this.stats,
        cacheHits: q.cacheHits,
        cacheMisses: q.cacheMisses,
        translateMs: Math.round(q.translateMs),
        merged: q.merged,            // 按片段拆回成功的合并单元数
        splitFailed: q.splitFailed,  // 片段边界不可信、退回逐节点的单元数
        groupErrors: q.groupErrors,  // 单个单元异常（已隔离并重排，不影响同批其它单元）
        drainErrors: q.drainErrors,  // 整批异常次数（只记账，绝不静默吞掉）
        requests: this.engine.stats.requests
      },
      ...extra
    });
  }

  /** 划词翻译等外部调用：单段文本的即席翻译（走同一套缓存与引擎） */
  async translateText(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 4000) return null;
    const cached = this.cache.get(t, this.engine.tl, this.engine.cacheTag);
    if (cached != null) return cached;
    try {
      const { ok } = await this.engine.translateMany([t]);
      const out = ok.get(t);
      if (out != null) this.cache.set(t, out, this.engine.tl, this.engine.cacheTag);
      return out;
    } catch (_) { return null; }
  }
}

function buildBaseUrls(over) {
  const base = {
    google: 'https://translate.googleapis.com',
    edge: 'https://edge.microsoft.com'
  };
  if (over && typeof over === 'object') {
    for (const k of ['google', 'edge', 'mock']) if (over[k]) base[k] = over[k];
  }
  return base;
}
