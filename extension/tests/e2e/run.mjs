import { chromium } from 'playwright';
import { createMockServer } from './mock-server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

// e2e 主流程：本地起 mock 站 + mock 翻译服务，用 Playwright 拉开源 Chromium 加载「本扩展目录」，
// 然后逐项断言（结构保真 / 译文对齐 / 批量请求 / Shadow DOM / OCR / 动态站 …）。
// 被加载的目录默认是仓库根（manifest.json 所在处）；设环境变量 OT_EXT_PATH 可指向别处 ——
// 用来直接验证「打包出来的 zip 解压后的目录」，见 tools/package.mjs 与 npm run verify:pack。
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const extPath = process.env.OT_EXT_PATH ? resolve(process.env.OT_EXT_PATH) : root;
const profileDir = join(root, '.test-profile');

const results = [];
function log(s) { console.log('[e2e]', s); }
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function waitFor(page, fn, timeout = 15000, step = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await page.waitForTimeout(step);
  }
  throw new Error('waitFor timeout: ' + (last && last.message ? last.message : ''));
}

/** 打开悬浮球 → 面板 → 整页翻译 */
async function enablePageTranslation(page) {
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
}

async function mockStats(base) {
  return (await fetch(base + '/__stats')).json();
}

/** 清掉扩展的译文缓存：让「请求数」可被断言（命中缓存时不会发请求） */
async function clearTranslationCache(sw) {
  if (!sw) return;
  try { await sw.evaluate(() => chrome.storage.local.remove('ot-cache-v3')); } catch (_) {}
}

const launched = { context: null, swId: null };
async function main() {
  rmSync(profileDir, { recursive: true, force: true });
  const { server, base } = await createMockServer();
  log('mock server at ' + base);

  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false, // 开源 Chromium 有头模式才支持 --load-extension
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-extensions-except=' + extPath,
        '--load-extension=' + extPath,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-features=Translate'
      ]
    });
    return ctx;
  };
  let context = null;
  let page = null;
  let extId = null;
  let sw = null;
    context = await launch();
    launched.context = context;
    // DOM 不变式探针：翻译前后逐节点比对（含 open shadow root），
    // 任何「新增/删除/移动/替换节点」都会被抓出来 —— 这是 React/lit 站点不崩的硬保证。
    await context.addInitScript(() => {
      const walk = (parent, out) => {
        for (const n of parent.childNodes) {
          out.push(n);
          if (n.nodeType === 1) {
            if (n.shadowRoot) walk(n.shadowRoot, out);
            walk(n, out);
          }
        }
        return out;
      };
      window.__otDomSnapshot = (root) => { const r = root || document.body; return { root: r, nodes: walk(r, []) }; };
      window.__otDomCompare = (prev, root) => {
        const r = root || (prev && prev.root) || document.body;
        const before = prev && prev.nodes ? prev.nodes : prev;
        const now = walk(r, []);
        if (now.length !== before.length) return { ok: false, reason: 'node-count', before: before.length, after: now.length };
        for (let i = 0; i < now.length; i++) {
          if (now[i] !== before[i]) return { ok: false, reason: 'node-replaced-or-moved', at: i, before: before[i].nodeName, after: now[i].nodeName };
        }
        const known = new Set(before);
        for (const n of now) {
          const p = n.parentNode;
          if (p && p !== r && !known.has(p)) return { ok: false, reason: 'parent-replaced', node: n.nodeName };
        }
        return { ok: true, count: now.length };
      };
    });
    page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  try {
    await waitFor(page, async () => {
      for (const worker of context.serviceWorkers()) {
        const url = worker.url();
        if (url.startsWith('chrome-extension://')) { extId = new URL(url).hostname; sw = worker; return true; }
      }
      return false;
    }, 10000, 300);
    log('extension id: ' + extId);
  } catch (_) {
    throw new Error('extension service worker not found（请确认已安装开源 Chromium: npx playwright install chromium）');
  }

  // 通过扩展 options 页写测试设置
  const seedSettings = {
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'replace',
    enabled: false,
    selTranslate: true,
    selPopupPinned: false,
    imgTranslate: true,
    translateUiLabels: false,  // 默认只翻译正文，不翻译 <button> 等交互控件
    providerChain: ['google'],
    concurrency: 8,
    requestJitterMs: [0, 0],   // 自动化测试关闭随机抖动（真机默认 50~200ms 防风控）
    retry: 1,
    hostOverrides: { google: base },
    ocr: { enabled: true, mode: 'mock', lang: 'eng' },
    customApi: {}
  };
    const seed = async (patch = {}) => {
      await page.goto(`chrome-extension://${extId}/dist/options.html`);
      await page.evaluate((settings) => chrome.storage.local.set({ 'ot-settings-v1': settings }), { ...seedSettings, ...patch });
    };
    await seed();
    log('test settings seeded');

  // ---------- 1. 划词翻译 ----------
  await page.goto(base + '/article.html');
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  check('内容脚本已注入（出现悬浮按钮）', true);
  await page.evaluate(() => {
    const p = document.querySelector('.story[data-n="3"]');
    const range = document.createRange();
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    range.setStart(texts[0], 0);
    range.setEnd(texts[texts.length - 1], texts[texts.length - 1].data.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await waitFor(page, () => page.locator('#ot-sel-card').count().then((n) => n > 0), 10000);
  await waitFor(page, () => page.locator('#ot-sel-card .ot-sel-dst.ot-done').count().then((n) => n > 0), 12000);
  const selText = await page.locator('#ot-sel-card .ot-sel-dst').innerText();
  check('划词翻译出现中文结果', selText.includes('译'), selText.slice(0, 40));

  // 收起
  await page.keyboard.press('Escape');

  // ---------- 2. 整页翻译 + 滚动不丢 ----------
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
  await waitFor(page, () => page.evaluate(() => {
    const done = document.querySelectorAll('[data-ot-done]').length;
    const pending = document.body.getAttribute && null;
    return done >= 24 ? done : 0;
  }), 25000);
  const translatedCount = await page.evaluate(() => document.querySelectorAll('[data-ot-done]').length);
  check('整页翻译单元数足够多', translatedCount >= 24, 'units=' + translatedCount);
  const bodySample = await page.locator('.story').first().innerText();
  check('首段译文生效', bodySample.includes('译'), bodySample.slice(0, 30));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const firstAfterScroll = await page.locator('.story').first().innerText();
  check('滚动后译文仍在（不消失）', firstAfterScroll.includes('译'), firstAfterScroll.slice(0, 30));

  // ---------- 2b. 结构保真：元素节点不重建、不丢失，译文严格对齐 ----------
    await clearTranslationCache(sw);
    await fetch(base + '/__reset');
    await page.goto(base + '/structure.html');
    await page.evaluate(() => { window.__snap = window.__otDomSnapshot(); });
    await enablePageTranslation(page);
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('#s-main > *[data-ot-done]').length).then((n) => n >= 4), 25000);
  const structureProbe = await page.evaluate(() => {
    const byId = (x) => document.getElementById(x);
    const txt = (x) => { const e = byId(x); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    // 只取容器自身可见文本（跳过 select/input/video 等被忽略子树内部的文本）
    const outerTxt = (x) => {
      const root = byId(x);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let out = '';
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (p && p.closest && p.closest('select,input,video,textarea,option')) continue;
        out += n.data;
      }
      return out.replace(/\s+/g, ' ').trim();
    };
    const refs = window.__refs || {};
    const ids = ['s-link', 's-bold', 's-lead', 's-only', 's-video', 's-select', 's-input', 's-img', 's-span', 's-em'];
    const same = {};
    for (const k of Object.keys(refs)) same[k] = byId('s-' + k) === refs[k];
    return {
      done: document.querySelectorAll('#s-main > *[data-ot-done]').length,
      inline: txt('with-inline'),
      leading: txt('with-leading'),
      leadingOnly: txt('with-leading-only'),
      media: outerTxt('with-media'),
      image: txt('with-img'),
      styled: txt('with-styled'),
      title: txt('s-title'),
      same,
      connected: ids.every((x) => { const e = byId(x); return !!e && e.isConnected; }),
      attrs: {
        alt: byId('s-img') && byId('s-img').getAttribute('alt'),
        value: byId('s-input') && byId('s-input').value,
        options: byId('s-select') ? byId('s-select').options.length : 0,
        optionText: byId('s-select') && byId('s-select').options[0] ? byId('s-select').options[0].textContent : '',
        href: byId('s-link') && byId('s-link').getAttribute('href'),
        color: byId('s-span') ? getComputedStyle(byId('s-span')).color : ''
      }
    };
  });
  check('整页翻译覆盖全部单元', structureProbe.done === 7, 'done=' + structureProbe.done);
  check('行内/媒体/表单元素节点身份完全保留（不重建 DOM）', structureProbe.connected && Object.values(structureProbe.same).every(Boolean), JSON.stringify(structureProbe.same));
  check('元素属性/状态保留（img alt、input value、select options、a href、行内样式）',
    structureProbe.attrs.alt === 'sample banner' && structureProbe.attrs.value === 'lab bench' &&
    structureProbe.attrs.options === 2 && structureProbe.attrs.optionText === 'Alpha plan' &&
    structureProbe.attrs.href === '/docs' && structureProbe.attrs.color === 'rgb(200, 0, 0)',
    JSON.stringify(structureProbe.attrs));
  // 新架构：翻译单元 = 单个 TextNode，所以行内标签两侧的文字各自成句（各自带译文前缀）。
  // 断言方式改为结构不变式：去掉译文前缀后必须与原文逐字一致 —— 单词不少、顺序不变、空格不丢。
  const stripMarks = (s) => String(s || '').split('【译】').join('').replace(/\s+/g, ' ').trim();
  check('译文与原文严格对齐：行内标签处不错位、不丢字',
    stripMarks(structureProbe.inline) === 'Please read the official docs and press Send feedback to continue.',
    structureProbe.inline);
  check('段落以行内标签开头时译文仍然对齐（打头译文不丢）',
    stripMarks(structureProbe.leading) === 'Breaking news from the open source hardware world today.',
    structureProbe.leading);
  check('整段文字都在行内标签里时译文仍然完整',
    stripMarks(structureProbe.leadingOnly) === 'Entirely italic sentence about open source boards',
    structureProbe.leadingOnly);
  check('媒体/表单夹在句子中间时译文仍然对齐',
    stripMarks(structureProbe.media) === 'Watch the demo and pick a for the next week.',
    structureProbe.media);
  check('带行内样式的段落译文完整', stripMarks(structureProbe.styled) === 'Styled inline span text and emphasised words stay intact.', structureProbe.styled);
  check('图片夹在句子中间时译文不留缺口', stripMarks(structureProbe.image) === 'The board ships worldwide from the Tindie store.', structureProbe.image);
  const strategy = await page.evaluate(() => {
    try { return JSON.parse(document.documentElement.dataset.otDebug || '{}').strategy || ''; } catch (_) { return ''; }
  });
  check('翻译链路是文本节点级（一个 TextNode 一个翻译单元）', strategy === 'text-node', 'strategy=' + strategy);
  const structureStats = await mockStats(base);
  const tokenLeak = (structureStats.requests || []).some((t) => /OTmT/i.test(String(t)));
  check('请求里不再出现占位符 token（占位符/整块抽取机制已彻底移除）', !tokenLeak, 'requests=' + (structureStats.requests || []).length);
  check('批量翻译：请求数远少于翻译单元数',
    structureStats.stats.gtx > 0 && structureStats.stats.gtx <= Math.max(1, Math.ceil(structureProbe.done / 2)),
    'gtx=' + structureStats.stats.gtx + ' units=' + structureProbe.done);
    await page.click('#s-bold');
    await page.click('#s-link');
    const listeners = await page.evaluate(() => window.__probe);
    check('翻译后事件监听仍有效（按钮/链接点击回调不丢）', listeners.boldClicks === 1 && listeners.linkClicks === 1, JSON.stringify(listeners));

    // 硬不变式：整页翻译（含行内元素打头这种「首槽位没有文本节点」的情况）前后，DOM 节点逐项完全一致。
    // 旧实现会在这里 createTextNode + insertBefore，React 站点随后 removeChild 就会抛错 → 白屏。
    const domInvariant = await page.evaluate(() => window.__otDomCompare(window.__snap));
    check('整页翻译前后 DOM 节点完全一致（无新增/删除/移动/替换）', domInvariant.ok, JSON.stringify(domInvariant));

    // 防死循环 / 防重复翻译：翻译完成后不得再产生请求
    const loopBefore = (await mockStats(base)).stats.gtx;
    await page.waitForTimeout(3000);
    const loopAfter = (await mockStats(base)).stats.gtx;
    check('翻译完成后不再重复请求（防死循环 / 防重复翻译）', loopAfter === loopBefore, 'gtx ' + loopBefore + '→' + loopAfter);

    // ---------- 2b. 关闭整页翻译：逐节点还原原文（新架构按 TextNode 记账，不需要刷新页面） ----------
    await page.click('#ot-fab');
    await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
    await page.click('#ot-panel .ot-btn-translate');
    await waitFor(page, () => page.evaluate(() => document.querySelectorAll('#s-main [data-ot-done]').length).then((n) => (n === 0 ? 1 : 0)), 15000);
    const restoreProbe = await page.evaluate(() => ({
      inline: document.getElementById('with-inline').textContent.replace(/\s+/g, ' ').trim(),
      marks: document.querySelectorAll('[data-ot-done], [data-ot-src]').length,
      dom: window.__otDomCompare(window.__snap)
    }));
    check('关闭整页翻译后逐节点还原原文（不刷新页面、无残留标记、节点身份不变）',
      restoreProbe.inline === 'Please read the official docs and press Send feedback to continue.' && restoreProbe.marks === 0 && restoreProbe.dom.ok,
      JSON.stringify({ marks: restoreProbe.marks, inline: restoreProbe.inline.slice(0, 34) }));
    // 还原后重新开启一次，保证还原不会把「已翻译」状态算成已完成
    await page.click('#ot-panel .ot-btn-translate');
    await waitFor(page, () => page.evaluate(() => document.querySelectorAll('#s-main > *[data-ot-done]').length).then((n) => n >= 4), 20000);
    check('还原后再次开启能重新翻译整页', true);

    // ---------- 2b2. 双语对照：只挂属性、绝不动 DOM（旧实现把容器搬进新建 wrapper，Reddit 直接白屏） ----------
    await clearTranslationCache(sw);
    await fetch(base + '/__reset');
    await seed({ mode: 'bilingual' });
    await page.goto(base + '/structure.html');
    await page.evaluate(() => { window.__snap = window.__otDomSnapshot(); });
    await enablePageTranslation(page);
    await waitFor(page, () => page.evaluate(() => document.querySelectorAll('#s-main > *[data-ot-done]').length).then((n) => n >= 4), 25000);
    const bilingualProbe = await page.evaluate(() => {
      const el = document.getElementById('with-leading');
      return {
        dom: window.__otDomCompare(window.__snap),
        zones: document.querySelectorAll('.ot-zone, .ot-orig, .ot-trans').length,
        marked: document.querySelectorAll('[data-ot-src]').length,
        src: el ? el.getAttribute('data-ot-src') : null,
        after: el ? getComputedStyle(el, '::after').content : '',
        same: Object.keys(window.__refs).every((k) => document.getElementById('s-' + k) === window.__refs[k]),
        translated: (document.getElementById('with-inline') || {}).textContent || ''
      };
    });
    check('双语对照：DOM 节点完全一致（不再包 .ot-zone wrapper）',
      bilingualProbe.dom.ok && bilingualProbe.zones === 0 && bilingualProbe.same,
      JSON.stringify(bilingualProbe.dom) + ' zones=' + bilingualProbe.zones);
    check('双语对照：原文以 data-ot-src + 伪元素呈现（伪元素不属于 DOM，React 无感）',
      bilingualProbe.marked >= 4 && !!bilingualProbe.src && String(bilingualProbe.after).includes('Breaking'),
      'marked=' + bilingualProbe.marked + ' src=' + String(bilingualProbe.src).slice(0, 24) + ' after=' + String(bilingualProbe.after).slice(0, 24));
    check('双语对照：译文仍写入原文本节点', bilingualProbe.translated.includes('译'), bilingualProbe.translated.slice(0, 30));
    await seed();

  // ---------- 2c. 引擎把多行合并成一个句子时必须退回逐条：宁可多请求，也不错位 ----------
  await clearTranslationCache(sw);
  await fetch(base + '/__mode?gtx=merge');
  await fetch(base + '/__reset');
  await page.goto(base + '/structure.html');
  await enablePageTranslation(page);
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('#s-main > *[data-ot-done]').length).then((n) => n >= 4), 30000);
  const mergeProbe = await page.evaluate(() => {
    const txt = (x) => { const e = document.getElementById(x); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    return { inline: txt('with-inline'), styled: txt('with-styled'), done: document.querySelectorAll('#s-main > *[data-ot-done]').length };
  });
  const mergeStats = await mockStats(base);
  check('批量结果对不齐时退回逐条翻译，译文仍然完整对齐',
    mergeProbe.done === 7 &&
    stripMarks(mergeProbe.inline) === 'Please read the official docs and press Send feedback to continue.' &&
    stripMarks(mergeProbe.styled) === 'Styled inline span text and emphasised words stay intact.',
    'gtx=' + mergeStats.stats.gtx + ' units=' + mergeProbe.done);
  check('退回逐条后请求数按文本数增长（说明确实重试而非猜着切）', mergeStats.stats.gtx > mergeProbe.done, 'gtx=' + mergeStats.stats.gtx);
  await fetch(base + '/__mode?gtx=lines');

  // ---------- 2d. 大页面：整页翻译要跟得上（旧实现整页扫描是 O(n²)，这种页面会直接卡死） ----------
  await clearTranslationCache(sw);
  await fetch(base + '/__reset');
  await page.goto(base + '/big.html');
  await enablePageTranslation(page);
  const bigStart = Date.now();
  const bigDone = await waitFor(page, () => page.evaluate(() =>
    document.querySelectorAll('.big > h3[data-ot-done], .big > .body[data-ot-done], .big > .inline[data-ot-done]').length
  ).then((n) => (n >= 2400 ? n : 0)), 60000);
  const bigMs = Date.now() - bigStart;
  const bigStats = await mockStats(base);
  const bigTail = await page.evaluate(() => {
    const first = document.querySelector('.big[data-i="0"] .body');
    const last = document.querySelector('.big[data-i="799"] .inline');
    return { first: first ? first.textContent.slice(0, 12) : '', last: last ? last.textContent.slice(0, 12) : '' };
  });
  check('大页面（800 段 × 3 单元）整页翻译在预算内完成', bigMs < 30000 && bigDone >= 2400, 'ms=' + bigMs + ' units=' + bigDone);
  check('大页面批量翻译请求数受控', bigStats.stats.gtx > 0 && bigStats.stats.gtx <= Math.ceil(bigDone / 8), 'gtx=' + bigStats.stats.gtx + ' units=' + bigDone);
  check('大页面首尾段落都翻译到位', bigTail.first.includes('译') && bigTail.last.includes('译'), JSON.stringify(bigTail));

  // ---------- 3. X 动态新增自动翻译 ----------
  await page.goto(base + '/x.html');
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.tweet .text[data-ot-done]').length).then((n) => n >= 3), 20000);
  // 等动态插入的新推文被自动翻译
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.tweet').length).then((n) => n >= 6), 12000);
  await waitFor(page, () => page.evaluate(() => {
    const items = [...document.querySelectorAll('.tweet .text[data-ot-done]')];
    return items.length;
  }).then((n) => n >= 6), 20000);
  const dynamicTranslated = await page.evaluate(() => {
    const ts = [...document.querySelectorAll('.tweet')].map((t) => t.querySelector('.text'));
    return ts.filter((t) => t && t.innerText.includes('译')).length;
  });
  check('X 实时新增推文自动翻译', dynamicTranslated >= 6, 'translated tweets=' + dynamicTranslated);

  // 虚拟化回流：删除再追加同一条（指纹缓存 → 0ms 恢复）
  await page.evaluate(() => {
    const feed = document.getElementById('feed');
    const first = feed.querySelector('.tweet');
    const clone = first.cloneNode(true);
    first.remove();
    feed.appendChild(clone);
  });
  await page.waitForTimeout(1600);
  const recycledOk = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.tweet')];
    return all.every((t) => { const x = t.querySelector('.text'); return x && x.innerText.includes('译'); });
  });
  check('虚拟化回收后回流推文译文恢复（指纹缓存）', recycledOk);

  // ---------- 4. Reddit 评论加载 ----------
  await page.goto(base + '/reddit.html');
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.comment .body[data-ot-done]').length).then((n) => n >= 3), 20000);
  await page.click('#more');
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.comment').length).then((n) => n >= 3), 10000);
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.comment .body[data-ot-done]').length).then((n) => n >= 5), 20000);
    const redditNested = await page.evaluate(() => document.querySelectorAll('.comment .body[data-ot-done]').length);
    check('Reddit 深层评论 + 加载更多自动翻译', redditNested >= 5, 'n=' + redditNested);

    // ---------- 4b. Reddit 新版结构：Web Component + open shadow root + 嵌套组件 + 无限滚动 ----------
    await clearTranslationCache(sw);
    await fetch(base + '/__reset');
    await page.goto(base + '/shadow.html');
    await page.evaluate(() => {
      window.__p1snap = window.__otDomSnapshot(document.getElementById('p1'));
      window.__ftsnap = window.__otDomSnapshot(document.getElementById('ft0'));
    });
    await enablePageTranslation(page);
    // 组件 shadow root 里的正文
    await waitFor(page, () => page.evaluate(() => {
      const h = document.getElementById('p1');
      return !!(h && h.shadowRoot && h.shadowRoot.querySelector('.body').textContent.includes('译'));
    }), 25000);
    // 嵌套组件（faceplate-tracker）+ slot 投递的 light DOM 标题
    await waitFor(page, () => page.evaluate(() => {
      const sr = document.getElementById('p1').shadowRoot;
      const nested = sr.querySelector('faceplate-tracker .lbl');
      const light = document.getElementById('ptitle');
      const ft = document.querySelector('#ft0 .lbl');
      return !!(nested && nested.textContent.includes('译') && light && light.textContent.includes('译') && ft && ft.textContent.includes('译'));
    }), 25000);
    // 无限滚动：后插入的组件同样自动翻译
    await waitFor(page, () => page.evaluate(() => {
      const el = document.getElementById('late-comment');
      return !!(el && el.shadowRoot && el.shadowRoot.querySelector('.body').textContent.includes('译'));
    }), 30000);
    const shadowProbe = await page.evaluate(() => {
      const p1 = document.getElementById('p1');
      const sr = p1.shadowRoot;
      const late = document.getElementById('late-comment');
      return {
        dom: window.__otDomCompare(window.__p1snap, p1),
        ftDom: window.__otDomCompare(window.__ftsnap, document.getElementById('ft0')),
        light: document.getElementById('ptitle').textContent,
        shadow: sr.querySelector('.body').textContent,
        nested: sr.querySelector('faceplate-tracker .lbl').textContent,
        lateShadow: late.shadowRoot.querySelector('.body').textContent,
        lateNested: late.shadowRoot.querySelector('faceplate-tracker .lbl').textContent,
        wrapKids: sr.querySelector('.wrap').childNodes.length,
        button: document.getElementById('vote').textContent,
        dbg: JSON.parse(document.documentElement.dataset.otDebug || '{}')
      };
    });
    check('Shadow DOM 正文被翻译（shreddit-post 的 open shadow root）', shadowProbe.shadow.includes('译'), shadowProbe.shadow.slice(0, 40));
    check('嵌套 Web Component 与 slot 投递的 light DOM 都被翻译',
      shadowProbe.nested.includes('译') && shadowProbe.light.includes('译'),
      JSON.stringify({ nested: shadowProbe.nested.slice(0, 20), light: shadowProbe.light.slice(0, 20) }));
    check('无限滚动新增的 shadow 组件自动翻译', shadowProbe.lateShadow.includes('译') && shadowProbe.lateNested.includes('译'), shadowProbe.lateShadow.slice(0, 30));
    check('shadow root 内部结构不变（无新增/删除/移动节点）',
      shadowProbe.dom.ok && shadowProbe.ftDom.ok && shadowProbe.wrapKids === 3,
      JSON.stringify(shadowProbe.dom) + ' kids=' + shadowProbe.wrapKids);
    check('默认跳过 <button>（不翻译交互控件）', shadowProbe.button === 'Upvote this thread', shadowProbe.button);
    check('调试信息报告已接入的 shadow root 数量', (shadowProbe.dbg.shadowRoots || 0) >= 2 && !!shadowProbe.dbg.stats,
      'shadowRoots=' + shadowProbe.dbg.shadowRoots + ' stats=' + JSON.stringify(shadowProbe.dbg.stats || {}).slice(0, 90));
  // ---------- 4c. 容器复用 / 流式覆盖：虚拟化回收后新文本必须被重新翻译 ----------
  // 旧实现把 data-ot-done / data-ot-skip 当「整棵子树跳过」的门：容器一旦译过就被永久拉黑，
  // Reddit 这类「回收复用同一个容器、换入全新文本」的页面会大片漏译。
  await clearTranslationCache(sw);
  await fetch(base + '/__reset');
  await page.goto(base + '/recycle.html');
  await enablePageTranslation(page);
  // 首轮：三块占位文本都要译到（此时容器会被打上 data-ot-done 标记）
  await waitFor(page, () => page.evaluate(() =>
    [...document.querySelectorAll('#app .cbody')].filter((d) => d.textContent.startsWith('【译】')).length
  ).then((n) => (n >= 3 ? n : 0)), 25000);
  // 之后页面复用这些容器、换入全新文本（含框架新建文本节点与流式追加），必须再次翻译
  const recycleOk = await waitFor(page, () => page.evaluate(() => {
    const t = (id) => ((document.getElementById(id) || {}).textContent || '');
    const one = t('r-slot1'), two = t('r-slot2'), three = t('r-slot3');
    // 复用后换入的是全新文本：译文必然重新带上前缀（slot3 是整块重译，会出现第二次前缀）
    const ok = one.startsWith('【译】') && one.includes('Recycled container')
      && two.startsWith('【译】') && two.includes('brand new text node')
      && (three.match(/【译】/g) || []).length >= 2 && three.includes('streamed-in tail');
    return ok ? { one, two, three } : 0;
  }), 25000);
  const recycleShape = await page.evaluate(() => ({
    injected: document.querySelectorAll('#app [class^="ot-"], #app [id^="ot-"]').length,
    slot3Kids: document.getElementById('r-slot3').childNodes.length
  }));
  check('容器被复用/换入新文本后仍会重新翻译（不被 data-ot-done 永久挡掉）',
    !!recycleOk,
    JSON.stringify({ one: recycleOk.one.slice(0, 20), two: recycleOk.two.slice(0, 20), three: recycleOk.three.slice(0, 20) }));
  check('容器复用期间插件未插入/搬动任何节点（只改文本节点）',
    recycleShape.injected === 0 && recycleShape.slot3Kids === 2,
    JSON.stringify(recycleShape));

  // ---------- 4d. 禁止整页 / 跨帖子合并：按帖子、按段落翻译，并过滤导航/页脚 ----------
  // 旧实现只认标准 HTML 块级标签：<shreddit-feed>/<shreddit-post> 这类自定义元素被当成「行内」，
  // 整个 feed（多帖 + 侧栏 + 页脚）并成一个单元，整页被拼成一长段。
  await clearTranslationCache(sw);
  await fetch(base + '/__reset');
  await page.goto(base + '/feed.html');
  const feedOrig = await page.evaluate(() => ({
    bodies: [...document.querySelectorAll('#feed .pbody')].map((e) => e.textContent),
    titles: [...document.querySelectorAll('#feed h3')].map((e) => e.textContent),
    nav: document.getElementById('nav').textContent,
    foot: document.getElementById('foot').textContent
  }));
  await enablePageTranslation(page);
  await waitFor(page, () => page.evaluate(() =>
    [...document.querySelectorAll('#feed .pbody')].filter((e) => e.textContent.startsWith('【译】')).length
  ).then((n) => (n >= 3 ? n : 0)), 25000);
  const feedProbe = await page.evaluate(() => {
    let dbg = {};
    try { dbg = JSON.parse(document.documentElement.dataset.otDebug); } catch (_) {}
    return {
      bodies: [...document.querySelectorAll('#feed .pbody')].map((e) => e.textContent),
      titles: [...document.querySelectorAll('#feed h3')].map((e) => e.textContent),
      nav: document.getElementById('nav').textContent,
      foot: document.getElementById('foot').textContent,
      dbg
    };
  });
  const feedStats = await mockStats(base);
  const sameAs = (got, orig) => got.length === orig.length && got.every((v, i) => v === '【译】' + orig[i]);
  // 每一次请求按行切开：同一行里绝不能同时出现两个帖子的文本（那就是跨帖合并）
  const POST_KEYS = ['First post body', 'Second post body', 'Third post body'];
  const noCrossPost = (feedStats.requests || []).every((t) =>
    String(t).split(String.fromCharCode(10)).every((line) => POST_KEYS.filter((k) => line.includes(k)).length <= 1));
  check('每个帖子 / 每个段落各自成单元（译文 = 各自的原文，未被拼接）',
    sameAs(feedProbe.bodies, feedOrig.bodies) && sameAs(feedProbe.titles, feedOrig.titles),
    JSON.stringify({ b0: feedProbe.bodies[0], t0: feedProbe.titles[0] }));
  check('翻译请求中同一行绝不出现两个帖子的文本（不跨帖子合并）', noCrossPost,
    'requests=' + (feedStats.requests || []).length);
  check('导航栏 / 页脚（非正文区域）不被翻译',
    feedProbe.nav === feedOrig.nav && feedProbe.foot === feedOrig.foot,
    JSON.stringify({ nav: feedProbe.nav.slice(0, 20), foot: feedProbe.foot.slice(0, 24) }));
  const feedMaxReq = (feedStats.requests || []).reduce((m, t) => Math.max(m, String(t).length), 0);
  check('单次翻译请求体量受控（不是把整页拼成一个超大请求）', feedMaxReq > 0 && feedMaxReq <= 4500,
    'maxRequestChars=' + feedMaxReq);
  check('单元粒度达到段落级（不是整页 1~2 个巨型单元）',
    ((feedProbe.dbg.stats || {}).units || 0) >= 6,
    'units=' + ((feedProbe.dbg.stats || {}).units || 0));

  // ---------- 4e. 商品网格（Tindie 形态）：每张卡片的标题/卖家/价格必须各自留在自己的卡片里 ----------
  // 旧架构现象：整个网格被当成一个单元，5 个标题 + 价格拼成一段写进第一个文本节点，
  // 其余文本节点被清空 —— 页面上就是「标题全部挤在图片上方一行，卡片里没有标题」。
  await clearTranslationCache(sw);
  await fetch(base + '/__reset');
  await page.goto(base + '/tindie.html');
  const gridOrig = await page.evaluate(() => {
    window.__cardRefs = [...document.querySelectorAll('#grid .card')];
    window.__imgRefs = window.__cardRefs.map((c) => c.querySelector('img'));
    window.__titleRefs = window.__cardRefs.map((c) => c.querySelector('.ctitle'));
    return window.__cardRefs.map((c) => ({
      title: c.querySelector('.ctitle').textContent,
      seller: c.querySelector('.seller').textContent,
      price: c.querySelector('.price').textContent
    }));
  });
  await enablePageTranslation(page);
  await waitFor(page, () => page.evaluate(() =>
    [...document.querySelectorAll('#grid .card')].filter((c) => c.querySelector('.ctitle').textContent.includes('译')).length
  ).then((n) => (n >= 5 ? n : 0)), 25000);
  const gridProbe = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grid .card')];
    return {
      titles: cards.map((c) => c.querySelector('.ctitle').textContent),
      sellers: cards.map((c) => c.querySelector('.seller').textContent),
      prices: cards.map((c) => c.querySelector('.price').textContent),
      cardsSame: cards.every((c, i) => c === window.__cardRefs[i]),
      imgsSame: cards.every((c, i) => c.querySelector('img') === window.__imgRefs[i]),
      titlesSame: cards.every((c, i) => c.querySelector('.ctitle') === window.__titleRefs[i]),
      titleKids: cards.map((c) => c.querySelector('.ctitle').childNodes.length),
      outside: (document.getElementById('th') || {}).textContent + ' ' + (document.getElementById('tf') || {}).textContent
    };
  });
  const gridStats = await mockStats(base);
  const cardKeys = ['CPS1', 'Ducky', 'TRNG', 'AirFlow', 'coffee roasting'];
  // 批量请求里多条文本是按行分隔的：同一行绝不能出现两个商品的文本（那就是跨卡片合并）
  const crossCard = (gridStats.requests || []).filter((t) =>
    String(t).split(String.fromCharCode(10)).some((line) => cardKeys.filter((k) => line.includes(k)).length > 1));
  // 标题与卖家是文本，必须各自带译文；价格是纯数字（$17.00）按文本语义规则不译，
  // 但必须原样留在自己的卡片里 —— 被搬走/清空同样是故障。
  const eachInOwnCard = gridProbe.titles.every((t, i) => t === '【译】' + gridOrig[i].title) &&
    gridProbe.sellers.every((t, i) => t === '【译】' + gridOrig[i].seller) &&
    gridProbe.prices.every((t, i) => t === gridOrig[i].price);
  check('商品网格：每张卡片的标题 / 卖家 / 价格各自翻译，没有被并成一段或写进同一个节点',
    eachInOwnCard,
    JSON.stringify({ t0: gridProbe.titles[0], t1: gridProbe.titles[1] }));
  check('商品网格：标题没有被堆到卡片外的任何位置（页面顶部 / 页脚保持原文）',
    gridProbe.outside.indexOf('CPS1') < 0 && gridProbe.outside.indexOf('$17.00') < 0,
    gridProbe.outside.replace(/\s+/g, ' ').slice(0, 60));
  check('商品网格：单次请求里绝不出现两个商品的文本（不跨卡片合并）',
    crossCard.length === 0, 'crossCard=' + crossCard.length + ' requests=' + (gridStats.requests || []).length);
  check('商品网格：卡片 / 图片 / 标题节点身份与子节点数完全不变（布局未被破坏）',
    gridProbe.cardsSame && gridProbe.imgsSame && gridProbe.titlesSame && gridProbe.titleKids.every((n) => n === 1),
    JSON.stringify({ cardsSame: gridProbe.cardsSame, imgsSame: gridProbe.imgsSame, titleKids: gridProbe.titleKids }));

  // ---------- 4f. 句级重建 Merge -> Translate -> Split（节点身份不变，片段各自回写）----------
  // 一句话被行内标签切成 5 个文本节点时：合并成一个单元整句翻译，再按片段分隔符切回各自节点。
  // 禁止的行为：把整句塞进第一个节点、清空其余节点（那就是「标题全挤在一起」的成因）。
  await clearTranslationCache(sw);
  await fetch(base + "/__mode?gtx=lines");
  await fetch(base + "/__reset");
  await page.goto(base + "/structure.html");
  await enablePageTranslation(page);
  await waitFor(page, () => page.evaluate(() => {
    let dbg = {};
    try { dbg = JSON.parse(document.documentElement.dataset.otDebug || "{}"); } catch (_) {}
    const st = dbg.stats || {};
    return dbg.phase === "done" && dbg.pending === 0 && (st.merged || 0) >= 1;
  }), 30000);
  const mergeChain = await page.evaluate(() => {
    const el = document.getElementById("with-inline");
    const kids = [...el.childNodes];
    let dbg = {};
    try { dbg = JSON.parse(document.documentElement.dataset.otDebug || "{}"); } catch (_) {}
    return {
      kids: kids.length,
      inlineKids: el.children.length,
      parts: kids.map((n) => (n.nodeType === 3 ? n.data : "<" + n.nodeName + ">")),
      text: el.textContent.replace(/\s+/g, " ").trim(),
      hasSep: el.textContent.indexOf(String.fromCharCode(1)) >= 0,
      merged: (dbg.stats || {}).merged || 0,
      splitFailed: (dbg.stats || {}).splitFailed || 0
    };
  });
  const mergeReq = await mockStats(base);
  const SEP = String.fromCharCode(1);
  const NL = String.fromCharCode(10);
  let mergedSegments = 0;
  for (const req of (mergeReq.requests || [])) {
    for (const line of String(req).split(NL)) {
      if (line.indexOf(SEP) >= 0 && line.includes("Please read the") && line.includes("Send feedback")) {
        mergedSegments = Math.max(mergedSegments, line.split(SEP).length);
      }
    }
  }
  check("句级重建：被行内标签切开的同一句话合并成一个翻译单元发出请求",
    mergedSegments === 5, "segments=" + mergedSegments);
  check("句级重建：译文按片段切回各自文本节点，子节点数与行内标签全部不变",
    mergeChain.kids === 5 && mergeChain.inlineKids === 2 && mergeChain.merged >= 1,
    JSON.stringify({ kids: mergeChain.kids, inline: mergeChain.inlineKids, merged: mergeChain.merged }));
  check("句级重建：整句译文没有被塞进任何一个文本节点（绝不 join 回单节点）",
    mergeChain.parts.filter((x) => x !== "<A>" && x !== "<B>").every((x) => x.length < mergeChain.text.length) &&
    mergeChain.parts.filter((x) => x !== "<A>" && x !== "<B>").every((x) => x.trim().length > 0),
    JSON.stringify(mergeChain.parts));
  check("句级重建后译文与原文仍然逐字对齐（不丢字、不错位、不残留分隔符）",
    stripMarks(mergeChain.text) === "Please read the official docs and press Send feedback to continue." && !mergeChain.hasSep,
    mergeChain.text);

  // ---------- 4f2. 引擎吞掉片段分隔符：整组退回逐节点翻译，绝不猜着切 ----------
  await clearTranslationCache(sw);
  await fetch(base + "/__mode?gtx=dropsep");
  await fetch(base + "/__reset");
  await page.goto(base + "/structure.html");
  await enablePageTranslation(page);
  const dropProbe = await waitFor(page, () => page.evaluate(() => {
    let dbg = {};
    try { dbg = JSON.parse(document.documentElement.dataset.otDebug || "{}"); } catch (_) {}
    const st = dbg.stats || {};
    if (!((st.splitFailed || 0) >= 1)) return null;
    if (dbg.phase !== "done" || dbg.pending !== 0) return null;
    const el = document.getElementById("with-inline");
    if (!el || !el.textContent.includes("译")) return null;
    return {
      text: el.textContent.replace(/\s+/g, " ").trim(),
      splitFailed: st.splitFailed || 0,
      hasSep: el.textContent.indexOf(String.fromCharCode(1)) >= 0
    };
  }), 30000);
  check("分隔符被引擎吞掉时整组退回逐节点翻译（识别出边界不可信）",
    dropProbe.splitFailed >= 1 && !dropProbe.hasSep,
    "splitFailed=" + dropProbe.splitFailed);
  check("退回逐节点后译文仍然逐字对齐（宁可多请求也不错位）",
    stripMarks(dropProbe.text) === "Please read the official docs and press Send feedback to continue.",
    dropProbe.text);
  await fetch(base + "/__mode?gtx=lines");

  // ---------- 4g. 页头规则：含 h1/h2 且不含 nav 的 <header> 属于正文 ----------
  await clearTranslationCache(sw);
  await fetch(base + "/__reset");
  await page.goto(base + "/header.html");
  await page.evaluate(() => { window.__hSnap = window.__otDomSnapshot(); });
  await enablePageTranslation(page);
  const headerProbe = await waitFor(page, () => page.evaluate(() => {
    const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
    const titleEl = document.querySelector("#h-title h1");
    if (!titleEl || !titleEl.textContent.includes("译")) return null;
    return {
      dom: window.__otDomCompare(window.__hSnap),
      title: txt("h-title"),
      navHeader: txt("h-nav"),
      foot: txt("h-foot"),
      body: txt("h-body")
    };
  }), 30000);
  check("页头含主标题（h1/h2）且不含导航 -> 按正文翻译", headerProbe.title.includes("译"), headerProbe.title.slice(0, 46));
  check("含导航的页头（站点顶栏）仍然不翻译", headerProbe.navHeader.indexOf("译") < 0, headerProbe.navHeader.slice(0, 40));
  check("页脚仍然不翻译", headerProbe.foot.indexOf("译") < 0, headerProbe.foot.slice(0, 34));
  check("正文照常翻译", headerProbe.body.includes("译"), headerProbe.body.slice(0, 34));
  check("页头规则生效期间页面 DOM 结构完全不变", headerProbe.dom.ok, JSON.stringify(headerProbe.dom));

  // ---------- 5. 类 hackaday：初始仅空容器，文字由 JS 延迟注入（不能只扫一次） ----------
  await page.goto(base + '/late.html');
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
  // 首批 1.6s 后注入
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.feeditem .desc[data-ot-done]').length).then((n) => n >= 2), 20000);
  // 第二批 3.6s 后追加到同一容器
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.feeditem .desc[data-ot-done]').length).then((n) => n >= 3), 15000);
  // 第三批 5.2s 后原位改写既有文本节点（characterData）
  await waitFor(page, () => page.evaluate(() => document.querySelectorAll('.feeditem .desc[data-ot-done]').length).then((n) => n >= 4), 25000);
  const lateDone = await page.evaluate(() => {
    const descs = [...document.querySelectorAll('.feeditem .desc')];
    const titles = [...document.querySelectorAll('.feeditem h3')];
    return { desc: descs.filter((d) => d.innerText.includes('译')).length, total: descs.length, titles: titles.filter((d) => d.innerText.includes('译')).length, totalTitles: titles.length };
  });
  check('类 hackaday 动态填充的 feed 持续被翻译', lateDone.desc === 4 && lateDone.total === 4 && lateDone.titles === 4 && lateDone.totalTitles === 4, 'desc=' + lateDone.desc + '/' + lateDone.total + ' title=' + lateDone.titles + '/' + lateDone.totalTitles);
  // ---------- 6. iframe：父页面开启整页翻译后 iframe 文本也进入翻译流程 ----------
  await page.goto(base + '/frame.html');
  await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
  await page.click('#ot-fab');
  await waitFor(page, () => page.locator('#ot-panel.ot-open').count().then((n) => n > 0));
  await page.click('#ot-panel .ot-btn-translate');
  // 顶层只有一个 <header>（含 h1、不含 nav）和一个 iframe：页头按正文翻译（见 4g 的页头规则），
  // iframe 里的正文另算。顶栏式页头（含 nav）仍然不翻译。
  const hostHeader = await waitFor(page, () => page.evaluate(() => {
    const el = document.getElementById('host-title');
    return el && el.textContent.includes('译') ? el.textContent : null;
  }), 25000);
  check('页头含 h1 且不含 nav -> 顶层页头按正文翻译', !!hostHeader && hostHeader.includes('译'), String(hostHeader).slice(0, 34));
  // iframe 内首批内容被同步翻译
  const iframeDone = await waitFor(page, async () => {
    const fr = page.frames().find((f) => f.url().includes('/frame-content.html'));
    if (!fr) return null;
    const done = await fr.evaluate(() => document.querySelectorAll('.fitem .fdesc[data-ot-done]').length).catch(() => 0);
    const txt = await fr.evaluate(() => ((document.querySelector('.fitem .fdesc') || {}).innerText) || '').catch(() => '');
    return done >= 1 && txt.indexOf('译') >= 0 ? { done, txt } : null;
  }, 20000);
  // iframe 内动态新增也被翻译
  const iframeLate = await waitFor(page, async () => {
    const fr = page.frames().find((f) => f.url().includes('/frame-content.html'));
    if (!fr) return null;
    const n = await fr.evaluate(() => document.querySelectorAll('.fitem .fdesc[data-ot-done]').length).catch(() => 0);
    return n >= 2 ? n : null;
  }, 20000);
  check('iframe 文本随整页翻译自动翻译（含动态新增）', !!(iframeDone && iframeDone.done >= 1) && iframeLate >= 2, 'iframe=' + (iframeDone ? iframeDone.done : 0) + ' late=' + iframeLate);



    // ---------- 5. 图片翻译（mock OCR → 图内底部统一翻译面板） ----------
    await page.goto(base + '/article.html');
    await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
    await page.evaluate(() => { window.__snap = window.__otDomSnapshot(); });
    await page.click('#sampleimg');
    await waitFor(page, () => page.locator('.ot-img-box .ot-trans-panel').count().then((n) => n >= 1), 20000);
    const imgProbe = await page.evaluate(() => {
      const box = document.querySelector('.ot-img-box');
      const panels = box ? [...box.querySelectorAll('.ot-trans-panel')] : [];
      const panel = panels[0] || null;
      const img = document.getElementById('sampleimg');
      const bbox = img ? img.getBoundingClientRect() : null;
      const r = panel ? panel.getBoundingClientRect() : null;
      return {
        panelCount: panels.length,
        boxCount: document.querySelectorAll('.ot-img-box').length,
        lineCount: document.querySelectorAll('.ot-img-line').length,
        pos: box ? getComputedStyle(box).position : null,
        boxParent: box ? box.parentElement.tagName : null,
        imgParent: img ? img.parentElement.tagName : null,
        imgInBox: !!(img && img.closest('.ot-img-box')),
        imgInlineStyle: img ? (img.getAttribute('style') || '') : 'x',
        fixedIdCount: document.querySelectorAll('[id^="ot-img-overlay"]').length,
        bodyImgCount: [...document.body.children].filter((n) => n.className && String(n.className).indexOf('ot-img-') === 0).length,
        text: panel ? panel.innerText : '',
        fontSize: panel ? getComputedStyle(panel).fontSize : '',
        inside: !!(r && bbox && r.left >= bbox.left - 1 && r.right <= bbox.right + 1 && r.bottom <= bbox.bottom + 1 && r.top >= bbox.top - 1),
        bottomGap: r && bbox ? Math.round(bbox.bottom - r.bottom) : -1,
        leftGap: r && bbox ? Math.round(r.left - bbox.left) : -1,
        rightGap: r && bbox ? Math.round(bbox.right - r.right) : -1,
        coversMostHeight: !!(r && bbox && r.height > bbox.height * 0.92),
        dom: window.__otDomCompare(window.__snap)
      };
    });
    const rowsText = (imgProbe.text || '').split('\n').filter((x) => x.trim());
    const textOk = imgProbe.panelCount === 1 && imgProbe.boxCount === 1 && imgProbe.lineCount === 0 && rowsText.length >= 2 && rowsText.every((t) => t.includes('译'));
    const styleOk = imgProbe.fontSize === '14px' && imgProbe.inside && imgProbe.bottomGap <= 20 &&
      Math.abs(imgProbe.leftGap - 10) <= 1 && Math.abs(imgProbe.rightGap - 10) <= 1 && !imgProbe.coversMostHeight;
    const diag = JSON.stringify({ panelCount: imgProbe.panelCount, lineCount: imgProbe.lineCount, fontSize: imgProbe.fontSize, inside: imgProbe.inside, bottomGap: imgProbe.bottomGap, leftGap: imgProbe.leftGap, rightGap: imgProbe.rightGap, rows: rowsText });
    check('点击图片 → OCR → 底部统一翻译面板（合并文本、固定14px、不按OCR框排版）',
      textOk && styleOk && imgProbe.pos === 'absolute' && imgProbe.fixedIdCount === 0 && imgProbe.bodyImgCount === 0,
      diag.slice(0, 200) + ' pos=' + imgProbe.pos);
    check('图片浮层不改动页面 DOM（img 不搬进容器、不改内联样式、body 节点不变）',
      imgProbe.dom.ok && imgProbe.boxParent === 'HTML' && imgProbe.imgParent === 'FIGURE' && !imgProbe.imgInBox && imgProbe.imgInlineStyle === '',
      JSON.stringify(imgProbe.dom) + ' boxParent=' + imgProbe.boxParent + ' imgParent=' + imgProbe.imgParent + ' style=' + JSON.stringify(imgProbe.imgInlineStyle));

  // 滚动后翻译面板仍与图片贴合
  const posBefore = await page.evaluate(() => {
    const box = document.querySelector('.ot-img-box');
    const panel = box.querySelector('.ot-trans-panel');
    const b = box.getBoundingClientRect();
    const r = panel.getBoundingClientRect();
    return { bx: b.left, by: b.top, lx: r.left, ly: r.top };
  });
  await page.evaluate(() => window.scrollBy(0, 260));
  await page.waitForTimeout(500);
  const posAfter = await page.evaluate(() => {
    const box = document.querySelector('.ot-img-box');
    const panel = box.querySelector('.ot-trans-panel');
    const b = box.getBoundingClientRect();
    const r = panel.getBoundingClientRect();
    return { bx: b.left, by: b.top, lx: r.left, ly: r.top };
  });
  const follows = Math.abs((posAfter.lx - posBefore.lx) - (posAfter.bx - posBefore.bx)) < 3 && Math.abs((posAfter.ly - posBefore.ly) - (posAfter.by - posBefore.by)) < 3;
  check('滚动后翻译面板仍与图片贴合不错位', follows, 'lineDeltaY=' + (posAfter.ly - posBefore.ly) + ' boxDeltaY=' + (posAfter.by - posBefore.by));

  // 「译/原」切换与 ✕ 还原
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.click('.ot-img-toggle');
  await page.waitForTimeout(200);
  const origShown = await page.evaluate(() => {
    const box = document.querySelector('.ot-img-box');
    const panels = [...box.querySelectorAll('.ot-trans-panel')];
    return { cls: box.classList.contains('ot-show-orig'), hidden: panels.length > 0 && panels.every((l) => getComputedStyle(l).visibility === 'hidden') };
  });
  check('「译/原」按钮可切回原图', origShown.cls && origShown.hidden);
  await page.click('.ot-img-toggle');
  await page.click('.ot-img-close');
  await waitFor(page, () => page.locator('.ot-img-box').count().then((n) => n === 0), 10000);
  const restored = await page.evaluate(() => ({
    imgOk: !!document.getElementById('sampleimg'),
    directParent: document.getElementById('sampleimg').parentElement.tagName,
    panelCount: document.querySelectorAll('.ot-trans-panel').length
  }));
    check('✕ 一键还原（图片回原父节点、无残留翻译面板）', restored.imgOk && restored.directParent === 'FIGURE' && restored.panelCount === 0);

    // ---------- 8b. React 管理的图片：同样绝不搬动节点（外挂浮层） ----------
    await page.goto(base + '/react-img.html');
    await waitFor(page, () => page.locator('#ot-fab').count().then((n) => n > 0));
    await page.evaluate(() => { window.__snap = window.__otDomSnapshot(); });
    const reactBefore = await page.evaluate(() => {
      const img = document.getElementById('reactimg');
      return { parent: img.parentElement.tagName, inBox: !!img.closest('.ot-img-box'), boxCount: document.querySelectorAll('.ot-img-box').length };
    });
    await page.click('#reactimg');
    await waitFor(page, () => page.evaluate(() => {
      const p = document.querySelector('.ot-img-box .ot-trans-panel');
      return !!(p && p.textContent.includes('译'));
    }), 25000);
    const reactImg = await page.evaluate(() => {
      const img = document.getElementById('reactimg');
      const box = document.querySelector('.ot-img-box');
      const r = img.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        parent: img.parentElement.tagName,
        inBox: !!img.closest('.ot-img-box'),
        boxParent: box.parentElement.tagName,
        glued: Math.abs(r.left - b.left) < 2 && Math.abs(r.top - b.top) < 2 && Math.abs(r.width - b.width) < 2 && Math.abs(r.height - b.height) < 2,
        dom: window.__otDomCompare(window.__snap),
        floatCount: document.querySelectorAll('[data-ot-float]').length,
        imgInlineStyle: img.getAttribute('style') || ''
      };
    });
    check('React 管理的图片不被搬动（img 父节点/内联样式/DOM 节点全部不变）',
      reactBefore.parent === 'FIGURE' && !reactBefore.inBox && reactImg.parent === 'FIGURE' && !reactImg.inBox &&
      reactImg.boxParent === 'HTML' && reactImg.dom.ok && reactImg.imgInlineStyle === '',
      JSON.stringify({ before: reactBefore, after: reactImg }).slice(0, 180));
    check('图片译文浮层与图片严丝合缝（外挂层跟随）', reactImg.glued && reactImg.floatCount === 1, 'glued=' + reactImg.glued);
    await page.evaluate(() => window.scrollBy(0, 180));
    await page.waitForTimeout(400);
    const reactFollow = await page.evaluate(() => {
      const img = document.getElementById('reactimg');
      const box = document.querySelector('.ot-img-box');
      const r = img.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return { dy: Math.abs(r.top - b.top), dx: Math.abs(r.left - b.left) };
    });
    check('滚动后图片浮层依旧贴合', reactFollow.dy < 3 && reactFollow.dx < 3, JSON.stringify(reactFollow));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.click('.ot-img-box .ot-img-close');
    await waitFor(page, () => page.locator('.ot-img-box').count().then((n) => n === 0), 10000);
    const reactRestored = await page.evaluate(() => ({
      parent: document.getElementById('reactimg').parentElement.tagName,
      boxCount: document.querySelectorAll('.ot-img-box').length,
      dom: window.__otDomCompare(window.__snap),
      inline: document.getElementById('reactimg').getAttribute('style') || ''
    }));
    check('图片浮层可一键移除且页面 DOM 完全复原',
      reactRestored.parent === 'FIGURE' && reactRestored.boxCount === 0 && reactRestored.dom.ok && reactRestored.inline === '',
      JSON.stringify(reactRestored));

  log('--- 汇总 ---');
  const fails = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过 🎉');

  try { await context.close(); } catch (_) {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  server.close();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] FATAL', e); try { server && server.close(); } catch (_) {} process.exit(2); });
