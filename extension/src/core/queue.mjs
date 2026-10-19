// ---------- 翻译队列层 + 映射层 + 合并层衔接 ----------
// 队列只做四件事：
//   0) 合并：把「同一容器内只隔着行内内容」的连续文本节点组成一个单元（merge.mjs），
//      让被行内标签切开的一句话作为整句翻译，而不是翻成互不相干的碎片；
//   1) 攒批次：默认 150 个单元一批（引擎层再按条数 / 字符数打包成批量请求）；
//   2) 去重：多个单元共用同一段文本时只请求一次（请求数只跟**不同文本数**有关）；
//   3) 严格 1:1 映射：单元[i] <- 自己那段文本的译文；合并单元按片段分隔符切回各自节点。
//
// 禁止：把一批文本拼成一个字符串请求，再把结果当成一段写回单个节点 —— 那正是
// 「多个帖子被拼成长文本 / 多个商品标题挤进同一个节点」的来源。
// 批量只发生在「一次请求里放多条互相独立的文本」，返回后每段文本各自对应自己的结果。
import { buildGroups, splitTranslation, endsWithSpace } from './merge.mjs';

export const QUEUE_BATCH = 150;

const defaultRules = () => ({ displayCache: new WeakMap() });

export class TranslateQueue {
  constructor({ engine, cache, batchSize = QUEUE_BATCH, onResult, onFail, sentenceMerge = true, getRules }) {
    this.engine = engine;
    this.cache = cache || null;
    this.batchSize = Math.max(1, Number(batchSize) || QUEUE_BATCH);
    this.onResult = typeof onResult === 'function' ? onResult : () => {};
    this.onFail = typeof onFail === 'function' ? onFail : () => {};
    this.sentenceMerge = sentenceMerge !== false;
    this.getRules = typeof getRules === 'function' ? getRules : defaultRules;
    this.pending = new Map();       // Text -> 待译文
    this.solo = new WeakSet();      // 拆分失败过的节点：永不参与合并（防「合并 -> 失败 -> 再合并」死循环）
    this.stats = {
      cacheHits: 0, cacheMisses: 0, translateMs: 0, failed: 0, pushes: 0, drops: 0,
      merged: 0,       // 成功按片段拆回的合并单元数
      splitFailed: 0,  // 片段边界不可信、退回逐节点的单元数
      groupErrors: 0,  // 单个单元处理异常（已隔离，不影响同批其它单元）
      drainErrors: 0   // 整批异常次数（只记账，绝不静默吞掉）
    };
    this._draining = null;
  }

  get size() { return this.pending.size; }

  push(node, text) {
    if (!node || !text) return false;
    if (this.pending.has(node)) return false;
    this.pending.set(node, text);
    this.stats.pushes++;
    return true;
  }

  clear() { this.pending.clear(); }

  /** 关闭 / 重开整页翻译、或设置变更时调用：丢掉待办与 solo 标记 */
  reset() {
    this.pending.clear();
    this.solo = new WeakSet();
  }

  _take(n) {
    const out = [];
    for (const [node, text] of this.pending) {
      out.push([node, text]);
      this.pending.delete(node);
      if (out.length >= n) break;
    }
    return out;
  }

  /** 单飞：同一时间只跑一条 drain 回路，页面持续改动时不断续跑 */
  drain() {
    if (this._draining) return this._draining;
    const run = (async () => {
      while (this.pending.size) {
        const batch = this._take(this.batchSize);
        if (!batch.length) break;
        await this._process(batch);
      }
    })();
    this._draining = run;
    run.then(() => { if (this._draining === run) this._draining = null; },
             (e) => { if (this._draining === run) this._draining = null; console.error('[ot-queue] DRAIN-FAIL', e && e.stack || e); });
    return run;
  }

  async _process(batch) {
    // ① 合并层：同一容器内只隔着行内内容的连续文本节点 -> 一个翻译单元（整句翻译）
    const nodes = [];
    for (const [node] of batch) {
      if (node && node.isConnected) nodes.push(node);
      else this.stats.drops++;
    }
    if (!nodes.length) return;

    let groups;
    if (this.sentenceMerge) {
      let rules = null;
      try { rules = this.getRules(); } catch (_) { rules = null; }
      groups = buildGroups(nodes, rules || defaultRules(), { isSolo: (n) => this.solo.has(n) });
    } else {
      groups = nodes.map((n) => ({ container: null, nodes: [n], merged: false, text: n.data }));
    }

    // ② 映射层：文本 -> 持有该文本的所有单元（请求数只跟「不同文本数」有关）
    const byText = new Map();
    const need = [];
    for (const g of groups) {
      if (!g.text) continue;
      const cached = this.cache ? this.cache.get(g.text, this.engine.tl, this.engine.cacheTag) : null;
      if (cached != null) {
        this.stats.cacheHits++;
        this._deliverSafely(g, cached);
        continue;
      }
      this.stats.cacheMisses++;
      let list = byText.get(g.text);
      if (!list) { list = []; byText.set(g.text, list); need.push(g.text); }
      list.push(g);
    }
    if (!need.length) return;

    let ok = new Map();
    const t0 = Date.now();
    try {
      const res = await this.engine.translateMany(need);
      ok = res && res.ok ? res.ok : new Map();
    } catch (_) { ok = new Map(); }
    this.stats.translateMs += Date.now() - t0;

    for (const [text, list] of byText) {
      const translated = ok.get(text);
      if (translated == null || !String(translated).trim()) {
        this.stats.failed += list.length;
        for (const g of list) for (const node of g.nodes) this.onFail(node, text);
        continue;
      }
      if (this.cache) this.cache.set(text, translated, this.engine.tl, this.engine.cacheTag);
      for (const g of list) this._deliverSafely(g, translated);
    }
  }

  /** 单个单元处理异常时隔离掉它：标记 solo（下次逐节点重试），绝不让整批静默失败 */
  _deliverSafely(group, translated) {
    try {
      this._deliver(group, translated);
    } catch (e) {
      this.stats.groupErrors++;
      this.lastError = e;
      const parts = group.parts || [];
      for (let i = 0; i < group.nodes.length; i++) {
        const node = group.nodes[i];
        this.solo.add(node);
        // 只重排「还是原文」的片段：已经写出去的片段再译一次会变成二次翻译
        const untouched = parts.length !== group.nodes.length || node.data === parts[i];
        if (untouched && node.isConnected && !this.pending.has(node)) this.pending.set(node, node.data);
      }
    }
  }

  /**
   * 把一个单元的译文分发到它自己的每个文本节点上。
   * 合并单元必须先切回片段：切片数不对（引擎吞掉 / 挪动了分隔符）就整组作废，
   * 退回逐节点翻译 —— 宁可多一次请求，也绝不猜着切、绝不把整句塞进一个节点。
   * 绝不 translations.join(' ') 再写回单个节点。
   */
  _deliver(group, translated) {
    const nodes = group.nodes;
    if (nodes.length === 1) { this.onResult(nodes[0], translated, null); return; }
    const parts = splitTranslation(translated, nodes.length);
    if (!parts) {
      this.stats.splitFailed++;
      for (const node of nodes) {
        this.solo.add(node);                       // 之后不再尝试合并
        if (node.isConnected) this.pending.set(node, node.data);
      }
      return;
    }
    this.stats.merged++;
    for (let i = 0; i < nodes.length; i++) {
      // 上一片段已经补过尾部空格时，本片段不再补首部空格，避免行首两个连续空格
      const prev = i > 0 ? nodes[i - 1].data : '';
      this.onResult(nodes[i], parts[i], { keepLeading: !endsWithSpace(prev) });
    }
  }
}
