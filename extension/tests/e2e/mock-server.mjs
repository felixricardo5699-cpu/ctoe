// 本地 HTTP：同时提供 翻译API(mock) 与 测试站点页面
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

// 片段分隔符 U+0001：客户端句级重建（Merge -> Translate -> Split）用它保住片段边界。
// mode=dropsep 模拟「把控制字符吃掉」的引擎 —— 客户端必须自己识别出片段边界不可信，
// 整组退回逐节点翻译，而不是猜着切。
const SEG = String.fromCharCode(1);

function translateMock(q, mode) {
  const clean = String(q || '').replace(/\s+/g, ' ').trim();
  const out = '【译】' + clean;
  return mode === 'dropsep' ? out.split(SEG).join('') : out;
}

// gtx 响应：[[[trans, orig, null, null, 10], ...], null, 'en']
// mode=lines：每行一个句子分组（真实引擎的常见形态，批量结果可按行边界拆分）
// mode=merge：所有行合并成一个分组（客户端必须拒绝拆分、退回逐条，绝不能猜着切）
function googleGtxBody(q, mode) {
  const lines = String(q == null ? '' : q).split('\n');
  const groups = [];
  if (mode === 'merge' && lines.length > 1) {
    groups.push({ trans: lines.map((l) => translateMock(l, mode)).join(' '), orig: lines.join('\n') });
  } else {
    for (const line of lines) groups.push({ trans: translateMock(line, mode), orig: line });
  }
  return [groups.map((g) => [g.trans, g.orig, null, null, 10]), null, 'en'];
}

// 大页面：整页翻译性能/批量请求的护栏（旧实现整页扫描是 O(n²)，这种页面会直接卡死）
function bigPage(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push('<article class="big" data-i="' + i + '">' +
      '<h3>Story ' + i + ' from the open source hardware roundup</h3>' +
      '<p class="body">Paragraph number ' + i + ' explains the open source power meter board and its worldwide shipping options in detail.</p>' +
      '<p class="inline">Read the <a href="/docs">official docs</a> for story ' + i + ' before you order the kit today.</p>' +
      '</article>');
  }
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>big page</title></head><body><main id="big-main">' + rows.join('') + '</main></body></html>';
}

function png640() {
  const W = 640, H = 240;
  const px = Buffer.alloc(W * H * 4, 255);
  const text = (x, y, w, h) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const k = (j * W + i) * 4; px[k] = 20; px[k + 1] = 30; px[k + 2] = 40; } };
  text(40, 100, 560, 28);   // mock OCR 会覆盖 42%-52% 高度
  text(120, 145, 400, 20);
  let c = 0xffffffff;
  const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc32 = (buf) => { let crc = 0xffffffff; for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ARTICLE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Open-source gadget review hub</title></head>
<body>
<header><h1 id="title">Gadget Weekly: open source hardware roundup</h1><p id="subtitle">Fresh picks from Tindie, Indiegogo and the maker community</p></header>
<main id="main">
<p class="story">This week we review a tiny open source power meter board that ships worldwide from the Tindie store.</p>
<p class="story">The campaign on Indiegogo just crossed its funding goal, and backers will receive early units next month.</p>
` +
Array.from({ length: 26 }, (_, i) => `<p class="story" data-n="${i}">Paragraph number ${i}: translation must stay even after you scroll far away from this text block. The quick brown fox jumps over the lazy dog again.</p>`).join('') +
`<section id="comments"><h2>Comments</h2>
<div class="comment"><p class="c">Great review, I already ordered two boards for my lab experiments.</p></div>
<div class="comment"><p class="c">Does the open source firmware support logging over WiFi? Please share details.</p></div>
</section></main>
<figure><img id="sampleimg" src="/sample.png" width="640" height="240" alt="OmniTranslate image translation demonstration banner"></figure>
<figure><img id="cnimg" src="/chinese.png" width="1000" height="240" alt="Chinese offline OCR test banner"></figure>
</body></html>`;

const X_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>X / Home</title></head>
<body>
<div id="app">
  <aside id="sidebar"><span class="side">For you</span><span class="side">Following</span></aside>
  <main id="feed" data-testid="feed">
    <article class="tweet" data-tid="1"><div class="author">Alice Dev</div><div class="text">Just shipped a new release of the open source library. The tests are all green and the docs are updated.</div></article>
    <article class="tweet" data-tid="2"><div class="author">Bob Maker</div><div class="text">My Indiegogo campaign update: 200% funded! Backers will get stretch goal rewards soon.</div></article>
    <article class="tweet" data-tid="3"><div class="author">Carol</div><div class="text">RT: Tindie discount code active this weekend for all open source hardware fans.</div></article>
  </main>
</div>
<script>
  let seq = 4;
  setInterval(() => {
    const feed = document.getElementById('feed');
    if (!feed || seq > 9) return;
    const a = document.createElement('article');
    a.className = 'tweet'; a.dataset.tid = seq;
    a.innerHTML = '<div class="author">Live User ' + seq + '</div><div class="text">Breaking live update number ' + seq + ': this tweet arrived after page load and must still be translated automatically.</div>';
    feed.appendChild(a);
    seq++;
  }, 1300);
</script>
</body></html>`;

const REDDIT_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>reddit: opensource</title></head>
<body>
<main id="post">
  <h1>r/opensource - show your best translation plugin workflow</h1>
  <div id="comments">
    <div class="comment" data-cid="1"><p class="body">I use bilingual mode on Reddit threads because product details matter to me.</p>
      <div class="reply"><p class="body">Same here! The nested comments on this thread are a good test case.</p>
        <div class="reply"><p class="body">A third level comment ensures deep nesting is translated too.</p></div>
      </div>
    </div>
  </div>
  <button id="more" data-testid="load-more">Load more comments</button>
  <script>
    let n = 4;
    document.getElementById('more').addEventListener('click', () => {
      const box = document.getElementById('comments');
      for (let k = 0; k < 2; k++, n++) {
        const d = document.createElement('div');
        d.className = 'comment'; d.dataset.cid = n;
        d.innerHTML = '<p class="body">Additional dynamic comment number ' + n + ' loaded on demand with more details for readers.</p>';
        box.appendChild(d);
      }
    });
  </script>
</main>
</body></html>`;

const LATE_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>hackaday.io/myFeed (late filled)</title></head>
<body>
<div class="container feed-container"></div>
<article class="feeditem feeditem-inplace"><h3>Fourth story waits for in-place text</h3><p class="desc" data-wait="1">&nbsp;</p></article>
<script>
  setTimeout(() => {
    const c = document.querySelector('.feed-container');
    if (!c) return;
    c.innerHTML =
      '<article class="feeditem"><h3>Hello from delayed feed one</h3><p class="desc">This item was injected after the very first scan and must still be translated.</p></article>' +
      '<article class="feeditem"><h3>Second delayed story</h3><p class="desc">Open source hardware updates keep arriving while you watch this page.</p></article>';
  }, 1600);
  setTimeout(() => {
    const c = document.querySelector('.feed-container');
    if (!c) return;
    const a = document.createElement('article');
    a.className = 'feeditem';
    a.innerHTML = '<h3>Late breaking feed three</h3><p class="desc">Even later items appended into the same container should be translated too.</p>';
    c.appendChild(a);
  }, 3600);
  setTimeout(() => {
    const w = document.querySelector('.feeditem-inplace .desc');
    if (!w || !w.firstChild) return;
    w.firstChild.nodeValue = 'This paragraph appears by rewriting the existing text node in place after the feed loaded.';
  }, 5200);
</script>
</body></html>`;
const FRAME_HOST = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>page hosting feed iframe</title></head>
<body>
<header><h1 id="host-title">Outer page header must stay translatable too</h1></header>
<iframe id="remote-feed" src="/frame-content.html" width="820" height="430" style="border:1px solid #ccc"></iframe>
</body></html>`;

const FRAME_CONTENT = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>feed inside iframe</title></head>
<body>
<main id="inner-feed">
  <article class="fitem"><h3>Article one inside the iframe</h3><p class="fdesc">This paragraph lives in a subframe and must be translated together with the outer page.</p></article>
</main>
<script>
  setTimeout(() => {
    const feed = document.getElementById('inner-feed');
    if (!feed) return;
    const a = document.createElement('article');
    a.className = 'fitem';
    a.innerHTML = '<h3>Late iframe item two</h3><p class="fdesc">A dynamically injected subframe paragraph should also enter the translation pipeline.</p>';
    feed.appendChild(a);
  }, 1600);
</script>
</body></html>`;

const SEED_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>seed</title></head><body><p>seed page - extension settings are injected through options page</p></body></html>`;

// React 管理页面的模拟：图片节点上带 React 内部键（__reactFiber$ / __reactProps$），
// 插件必须"不搬动任何节点"，否则 React 之后 removeChild 会抛错。
const REACT_IMG = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>react managed image</title></head>
<body>
<main id="root"><div class="post"><p>React managed post body with an image below.</p><figure><img id="reactimg" src="/sample.png" width="640" height="240" alt="React managed banner"></figure></div></main>
<script>
  const img = document.getElementById('reactimg');
  img.__reactProps$abc123 = { src: '/sample.png' };
  img.__reactFiber$abc123 = { tag: 5 };
</script>
</body></html>`;

// 模拟 Reddit 新版：React 外壳 + Web Component（shreddit-post / shreddit-comment / faceplate-tracker），
// 正文渲染在 open shadow root 里；再加一条无限滚动式的新增组件。
const SHADOW_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>shreddit-like thread</title></head>
<body>
<div id="app"><shreddit-post id="p1"><span id="ptitle" slot="title">Open source hardware threads need proper context</span></shreddit-post><div id="ftbox"><faceplate-tracker id="ft0"><span id="lbl0" class="lbl">Tracker label outside any shadow root</span></faceplate-tracker></div><button id="vote">Upvote this thread</button></div>
<script>
  // 组件模板：正文写在 open shadow root 里（lit 常见做法）
  function attach(root, body, label) {
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const style = document.createElement('style');
    style.textContent = '.wrap{display:block}';
    const d = document.createElement('div');
    d.className = 'body';
    d.textContent = body;
    const tracker = document.createElement('faceplate-tracker');
    tracker.className = 'trk';
    const span = document.createElement('span');
    span.className = 'lbl';
    span.textContent = label;
    tracker.appendChild(span);
    wrap.appendChild(style);
    wrap.appendChild(d);
    wrap.appendChild(tracker);
    root.appendChild(wrap);
    // 与真实 shreddit-* 一致：light DOM 的标题通过具名 slot 渲染出来
    const titleSlot = document.createElement('slot');
    titleSlot.name = 'title';
    root.appendChild(titleSlot);
  }
  class ShredditPost extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      attach(root, 'Comment body rendered inside the shadow root of a web component.', 'Label inside a nested component');
    }
  }
  class ShredditComment extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      attach(root, 'A comment that arrived later through infinite scrolling still needs translation.', 'Late nested label for the tracker');
    }
  }
  customElements.define('shreddit-post', ShredditPost);
  customElements.define('shreddit-comment', ShredditComment);
  setTimeout(() => {
    const el = document.createElement('shreddit-comment');
    el.id = 'late-comment';
    document.getElementById('app').appendChild(el);
  }, 1500);
</script>
</body></html>`;

// 模拟 Reddit 的虚拟化回收 / 流式填充：同一个容器先出现占位文本（会被翻译并打标记），
// 随后容器被复用、换入全新内容（React 重建子树 / 流式追加），插件必须重新翻译——
// 旧实现把 data-ot-done 当「整棵子树跳过」的门，这些新文本会永久漏译。
const RECYCLE_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>recycled containers</title></head>
<body>
<main id="app">
  <div id="r-slot1" class="cbody">Loading comments for this thread</div>
  <div id="r-slot2" class="cbody"><span class="lead">Placeholder body part one</span></div>
  <div id="r-slot3" class="cbody">Another placeholder that will be streamed over later</div>
</main>
<script>
  // 1) 复用同一个容器，直接换掉文本（textContent 会换成全新的文本节点）
  setTimeout(() => {
    const el = document.getElementById('r-slot1');
    if (el) el.textContent = 'Recycled container now shows a completely different comment that must be translated.';
  }, 1500);
  // 2) 复用容器 + 由框架新建文本节点（React 重建子树的做法）
  setTimeout(() => {
    const el = document.getElementById('r-slot2');
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode('A brand new text node created by the framework needs translating too.'));
  }, 2200);
  // 3) 流式追加：同一个容器里再插入一段新文本
  setTimeout(() => {
    const el = document.getElementById('r-slot3');
    if (!el) return;
    const tail = document.createElement('span');
    tail.textContent = ' and a streamed-in tail that arrived after the first pass';
    el.appendChild(tail);
  }, 2900);
</script>
</body></html>`;

// 模拟 Reddit 首页结构：整块内容放在自定义元素（<shreddit-feed>/<shreddit-post>）里，
// 旁边还有侧栏、导航、页脚。旧实现只认标准 HTML 块级标签 → 自定义元素被当成「行内」，
// 于是整个 feed（多个帖子 + 侧栏 + 页脚）被并成一个翻译单元，整页被拼成一长段。
const FEED_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>shreddit feed</title>
<style>shreddit-feed,article,shreddit-post{display:block}</style></head>
<body>
<nav id="nav"><span>Reddit home</span><span>Search Reddit</span></nav>
<div id="main-content">
  <shreddit-feed id="feed">
    <article id="post-1"><h3>Post one title about hardware</h3><p class="pbody">First post body sentence about open source hardware threads.</p></article>
    <article id="post-2"><h3>Post two title about finance</h3><p class="pbody">Second post body sentence about index fund allocation.</p></article>
    <article id="post-3"><h3>Post three title about tools</h3><p class="pbody">Third post body sentence about soldering irons.</p></article>
  </shreddit-feed>
  <div id="sidebar"><h2>About community</h2><p class="sbody">Sidebar blurb that is not post content.</p></div>
</div>
<footer id="foot"><p>Copyright 2026 Reddit Inc. All rights reserved.</p></footer>
</body></html>`;

// 模拟 Tindie 类商品网格：每张卡片里是「标题（<a> 内单文本节点）+ 卖家 + 价格 + 图片」。
// 旧架构把整个网格当成一个单元，会把所有标题/价格拼成一段写进第一个文本节点、
// 其余清空 —— 现象就是「标题全部挤在图片上方一行，卡片里没有标题」。
const TINDIE_LIKE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tindie - Discover awesome hardware</title>
<style>.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;list-style:none;padding:0}.card{display:block}.meta{display:flex;gap:6px}</style></head>
<body>
<header id="th"><h1>Explore our latest products</h1><div class="sub">Find something interesting</div></header>
<ul class="grid" id="grid">
  <li class="card" data-i="1"><a class="ctitle" href="/p/1">CPS1 to CPS2 Kick Harness adapter</a><div class="meta"><span class="seller">BigP</span><span class="price">$17.00</span></div><img src="/sample.png" width="200" height="120" alt="CPS1 adapter"></li>
  <li class="card" data-i="2"><a class="ctitle" href="/p/2">DSTIKE White Ducky S3 Wi-Fi USB automation</a><div class="meta"><span class="seller">Travis Lin</span><span class="price">$39.00</span></div><img src="/sample.png" width="200" height="120" alt="Ducky"></li>
  <li class="card" data-i="3"><a class="ctitle" href="/p/3">QsQuantum TRNG USB true random generator</a><div class="meta"><span class="seller">QsQuantum</span><span class="price">$51.99</span></div><img src="/sample.png" width="200" height="120" alt="TRNG"></li>
  <li class="card" data-i="4"><a class="ctitle" href="/p/4">AirFlow project ESP32 PWM fan controller</a><div class="meta"><span class="seller">Omega Projects</span><span class="price">$999.00</span></div><img src="/sample.png" width="200" height="120" alt="AirFlow"></li>
  <li class="card" data-i="5"><a class="ctitle" href="/p/5">ESP32-S3 coffee roasting controller</a><div class="meta"><span class="seller">tbRoast</span><span class="price">$179.00</span></div><img src="/sample.png" width="200" height="120" alt="Roaster"></li>
</ul>
<footer id="tf"><p>Copyright 2026 Tindie Inc. All rights reserved.</p></footer>
</body></html>`;

// 页头规则：<header> 里含 h1/h2 且不含 nav 时属于正文标题区；含 nav 的站点顶栏仍然跳过。
const HEADER_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>header rules</title></head>
<body>
<header id="h-title"><h1>Open source hardware weekly digest</h1><p>Fresh picks for people who build their own instruments</p></header>
<header id="h-nav"><h1>Site name</h1><nav><a href="/">Home</a> <a href="/about">About us</a></nav></header>
<main id="h-main"><p id="h-body">Main article body text that must be translated as usual.</p></main>
<footer id="h-foot"><p>Copyright 2026 Example Inc. All rights reserved.</p></footer>
</body></html>`;

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createMockServer() {
  return new Promise((resolve) => {
    const state = { gtxMode: 'lines', stats: { gtx: 0, mock: 0, html: 0 }, requests: [] };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/__stats') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ gtxMode: state.gtxMode, stats: state.stats, requests: state.requests.slice(-300) }));
        return;
      }
      if (u.pathname === '/__reset') {
        state.stats.gtx = 0;
        state.stats.mock = 0;
        state.stats.html = 0;
        state.requests.length = 0;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (u.pathname === '/__mode') {
        state.gtxMode = u.searchParams.get('gtx') || 'lines';
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, gtxMode: state.gtxMode }));
        return;
      }
      if (u.pathname === '/translate_a/single' || u.pathname === '/gtx') {
        state.stats.gtx++;
        state.requests.push(u.searchParams.get('q') || '');
        if (state.requests.length > 400) state.requests.shift();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(googleGtxBody(u.searchParams.get('q') || '', state.gtxMode)));
        return;
      }
      if (u.pathname === '/mock') {
        state.stats.mock++;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ translatedText: translateMock(u.searchParams.get('q') || '', state.gtxMode) }));
        return;
      }
      if (u.pathname === '/chinese.png') {
        const p = join(__dirname, 'testdata', 'chinese.png');
        if (!existsSync(p)) { res.statusCode = 404; res.end('no chinese.png'); return; }
        res.setHeader('content-type', 'image/png');
        res.end(readFileSync(p));
        return;
      }
      if (u.pathname === '/sample.png') {
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'no-store');
        res.end(png640());
        return;
      }
      let body = '';
      if (u.pathname === '/') body = ARTICLE;
      else if (u.pathname === '/article.html') body = ARTICLE;
      else if (u.pathname === '/structure.html') body = readFileSync(join(__dirname, 'testdata', 'structure.html'), 'utf8');
      else if (u.pathname === '/big.html') body = bigPage(800);
      else if (u.pathname === '/shadow.html') body = SHADOW_LIKE;
      else if (u.pathname === '/recycle.html') body = RECYCLE_LIKE;
      else if (u.pathname === '/feed.html') body = FEED_LIKE;
      else if (u.pathname === '/react-img.html') body = REACT_IMG;
      else if (u.pathname === '/x.html') body = X_LIKE;
      else if (u.pathname === '/reddit.html') body = REDDIT_LIKE;
      else if (u.pathname === '/late.html') body = LATE_LIKE;
      else if (u.pathname === '/frame.html') body = FRAME_HOST;
      else if (u.pathname === '/frame-content.html') body = FRAME_CONTENT;
      else if (u.pathname === '/tindie.html') body = TINDIE_LIKE;
      else if (u.pathname === '/header.html') body = HEADER_PAGE;
      else if (u.pathname === '/seed.html') body = SEED_PAGE;
      else { res.statusCode = 404; res.end('not found'); return; }
      state.stats.html++;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
