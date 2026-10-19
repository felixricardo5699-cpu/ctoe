# OmniTranslate 万译 — 设计文档

> 英文网站 → 中文（含评论、实时动态），一键整页、划词即译、点图即译图片。
> 目标：任何网站兼容、翻译不随滚动消失、动态内容自动补译、iframe 文本同步、开源且零付费。

## 一、功能总览
1. **一键整页翻译 / 还原**
   - 工具栏弹窗、页面悬浮球（右下角「译」）或快捷键 `Alt+T` 切换。
   - 默认「仅中文」，可切换「双语对照」（原文以 CSS 伪元素显示，不动 DOM 结构）。
   - 顶栏按钮 / 悬浮球状态徽标：待译 / 翻译中(N) / 完成。
2. **翻译不随滚动消失（关键设计）**
   - 整页一次性翻译，而不是「只翻译可见区」。
   - 动态新增（滚动加载、翻页、展开评论、无限流）由 MutationObserver 自动补译（新增子树走提取层重扫，文本原位改写直接重译该节点）；对「初始仅空容器、正文由 JS 延迟填充」的动态页（如 hackaday.io/myFeed）再加按需兜底重扫（见 3.6 / 3.7）。
   - manifest 以 `all_frames` 注入：iframe 内文本同样自动补译；子框架只做翻译、不挂悬浮 UI（`content.js` 的 `isTopFrame` 判断 + 后台 `ot-frame-set / ot-frame-query` 帧状态同步）。
   - 已翻译文本指纹缓存：虚拟 DOM 回收后再插入同一内容时直接恢复，不重译、不闪烁。
3. **整页扫描容错**
   - 遍历中若被异常节点打断，已收集到的文本节点照常进入翻译队列（提取层对单棵子树 try/catch，兜底重扫会在下一轮补齐其余内容）。
4. **划词翻译**
   - 鼠标划选英文 → 自动弹出中文小卡；拖动时实时更新；可固定小卡、复制、`Esc` 关闭。
   - 支持划选被 HTML 拆散的句子：跨行跨标签自动合并整句再译。
5. **图片翻译（选择性）**
   - 开启「图片翻译模式」后点击图片，离线 OCR（Tesseract.js，开源）识别图中文字 → 翻译 → 在图片上叠加译文浮层（译文合并为普通文本、固定 14px、自动换行、半透明黑底白字、不按 OCR 坐标排版，随图片滚动缩放不错位）；可「译文 / 原图」切换、✕ 一键还原。
   - 译文浮层挂在 `document.documentElement` 下、用文档绝对定位跟随图片，**完全不改动图片及其父节点**。
   - 右键图片 →「翻译此图片」也可触发；后台按 `frameId` 定向发送到含该图片的框架。
   - 每张图需用户主动点击，不做全站自动扫描，保护隐私。
6. **实时站点兼容（含 Shadow DOM）**
   - 没有写死站点适配器，也没有任何站点名分支：用「TreeWalker 提取 TextNode（含递归进入 open shadow root）+ 通用过滤规则 + MutationObserver + iframe 同步」覆盖所有站点（见 3.11）。
   - 已实测覆盖：X/Twitter（实时时间线、虚拟化回流）、Reddit 新版（`shreddit-post` / `shreddit-comment` / `faceplate-tracker` 的 shadow DOM、嵌套组件、slot 投射、无限滚动）、hackaday（延迟填充 feed）、Tindie/Indiegogo/Kickstarter 类商品与活动页。
   - 兼容性矩阵见「六、兼容性检查」。
7. **引擎与降级（全免费、可自定义）**
   - `google`：Google 网页翻译免费端点（client=gtx）。
   - `edge`：Microsoft Edge 免费端点（无鉴权 `edge.microsoft.com/translate/translatetext`；微软已下线旧版「auth token + api-edge…+/translate」流程）。
   - `mock`：本地测试 / 离线翻译。
   - `custom`：任意 OpenAI 兼容或自定义 HTTP 翻译 API。
   - 默认 Google 优先，失败自动降级 Edge；首个请求并发探测各引擎并记忆“最快可用引擎”，后续优先复用它，失效引擎临时熔断快速切换。每条文本按「原文 hash + 目标语言 + 引擎」缓存，同页不重复调用 API。
8. **调试**
   - 每个 frame 暴露 `window.__otDebug`：phase / pending / done / failed / lastScan / mode / strategy / shadowRoots / stats / engine chain（`frame` 字段标明 top/child），便于线上排查“能划词不能整页”一类问题。
   - 因内容脚本运行在隔离世界，页面主世界读不到 `window.__otDebug`；同一份状态会镜像到 `<html data-ot-debug="...">`（JSON，状态变化时才写，避免无谓的 DOM 属性变更），F12 里用 `JSON.parse(document.documentElement.dataset.otDebug)` 可直接读取。

## 二、工程结构
```
omni-translate/                ← 加载解压扩展时选择的根目录
├── manifest.json              MV3 清单（http/https、all_frames、快捷键、CSP）
├── dist/                      构建产物（content.js、content.css、sw.mjs、popup/options/offscreen、icons）
├── src/
│   ├── content.js             内容脚本入口（esbuild → IIFE；顶层 UI + 子框架翻译同步）
│   ├── core/
│   │   ├── rules.mjs          规则层：标签 / 区域 / 可见性 / 文本语义（无站点判断）
│   │   ├── text-nodes.mjs     提取层：TreeWalker 只收集 TextNode（含 shadow DOM）
│   │   ├── queue.mjs          翻译队列层 + 映射层（批量请求，严格 1 节点 1 结果）
│   │   ├── writer.mjs         回写层：node.data = 译文、原文记账与还原、双语属性
│   │   ├── observer.mjs       MutationObserver 层（新增子树 / 原位改写 → 重扫或重译）
│   │   ├── translator.mjs     编排层：开关、状态、还原、兜底重扫（PageTranslator）
│   │   ├── settings.mjs cache.mjs text.mjs sha256.mjs engines.mjs
│   │   └── selection.mjs image.mjs panel.mjs misc.mjs
│   ├── background/service-worker.mjs   消息路由/帧同步/离屏 OCR 调度/右键/快捷键
│   ├── offscreen/             离屏页：Tesseract OCR 等重活
│   ├── popup/ options/ ui/ assets/
├── vendor/tesseract/          离线 OCR：worker + core(.wasm) + eng/chi_sim/chi_tra 语言包
├── tests/unit/ tests/e2e/     node:test 单测 + Playwright 本地 mock e2e
├── tools/gen-icons.mjs  build.mjs  fetch-ocr.mjs
└── README.md  DESIGN.md  LICENSE  package.json
```

## 三、核心架构：七层流水线，所有网站共用同一条路径

### 3.0 数据流

```
网页 DOM
  │
  ▼ ① DOM 提取层   src/core/text-nodes.mjs   collectTextNodes(root, rules)
  │     document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT)，只产出 TextNode
  │     元素命中规则时 FILTER_REJECT 直接剪掉整棵子树（脚本/样式/代码/导航/页脚/广告…）
  │     TreeWalker 不跨 shadow 边界 → 在遍历元素的同一趟里收集 open shadow root 继续走
  ▼ ② 文本过滤层   src/core/rules.mjs
  │     标签规则 + 区域规则 + 可见性规则 + 文本语义规则（四类通用启发式）
  ▼ ③ 合并层       src/core/merge.mjs        buildGroups / splitTranslation
  │     同一容器内只隔着行内内容的连续文本节点 → 一个单元（整句翻译）；
  │     请求用片段分隔符保住片段边界，译文按分隔符切回各自节点 —— 节点身份完全不变
  ▼ ④ 翻译队列     src/core/queue.mjs        TranslateQueue.push(node, text)
  │     攒批（150 单元/批，引擎层再按 32 条 / 3000 字切片）+ 同文本去重
  ▼ ⑤ 映射层       src/core/queue.mjs
  │     严格 1:1：单元[i] ← 「单元[i] 自己那段文本」的译文；缺结果就计失败，绝不拿别人的顶上
  ▼ ⑥ 回写层       src/core/writer.mjs       node.data = 译文
  │     全链路唯一写操作；原文按节点记账，关闭翻译时逐节点还原（不刷新页面）
  ▼ ⑦ MutationObserver  src/core/observer.mjs
        新增节点 / 原位改写文本 → 新节点回到 ①，被改写的文本节点直接回到 ④
```

编排在 `src/core/translator.mjs`（`PageTranslator`）：开关、状态上报、还原、兜底重扫、防死循环。

**回写粒度恒为「一个 TextNode 一个片段」**。不做「容器 + 子节点区间」的整块抽取，
因此两个帖子、两个商品标题永远不会进同一个请求项，也不会被写进同一个节点。
③ 只决定「请求里发什么」（同一句话可以合并成一条整句），回写仍然严格按节点分发。

### 3.1 硬不变式：绝不改动页面 DOM 结构
React SPA（Reddit 新版）与 Web Component 站点上，fiber / 虚拟 DOM 持有真实节点引用。
任何「新建 / 删除 / 移动 / 替换节点」都会让框架树与真实 DOM 对不上：
轻则布局错乱（grid/flex 多出一层 wrapper），重则 `removeChild` 抛错、整棵 React 树崩掉。
因此整条翻译链路只允许一个原语：

```js
textNode.data = translated   // 等价于 textNode.textContent = 译文
```

明确禁止（本仓库的**页面翻译链路**里任何位置都不出现）：`element.innerHTML` /
`element.outerHTML` / `document.body.innerText` / `document.body.textContent` / `document.write` /
`replaceWith` / `insertAdjacentHTML` / `createElement` / `createTextNode` / `insertBefore` /
`appendChild` / `removeChild` / 移动既有节点。

- 唯一例外是插件**自己的 UI**（悬浮球、面板、图片译文浮层、划词小卡）：它们由 `misc.mjs` 的 `el()`
  在 `ot-` 命名空间下创建，从不改动页面节点（`panel.mjs` / `selection.mjs` / `image.mjs`）。
- 不翻译任何页面属性：`aria-label` / `class` / `id` / `href` / `src` / `data-*` 一律不动；
  只额外挂两个**标记属性** `data-ot-done`（这块已译）与 `data-ot-src`（双语对照的原文）。
- 不改任何 `display / flex / grid / position`：双语对照用 CSS 伪元素 `attr(data-ot-src)` 渲染原文，
  伪元素不属于 DOM；flex/grid/inline 容器直接跳过双语标记，避免多出一个盒子改变排版。
- **图片浮层外挂**：`image.mjs` 的译文浮层挂在 `document.documentElement` 下，用文档绝对定位跟随图片，
  不把 `<img>` 搬进容器，也不改图片内联样式。

### 3.2 ① 提取层：TreeWalker 只收集 TextNode
`collectTextNodes(root, rules, opts)`：

- `doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, { acceptNode })`，一趟遍历；
- 元素命中「标签规则 / 区域规则」→ `FILTER_REJECT`（整棵子树剪掉，且不会被继续遍历）；
- 文本节点命中「文本语义规则 + 可见性」→ `FILTER_ACCEPT` 收进结果数组；
- 遍历元素时顺手记录 `el.shadowRoot`，遍历结束后按发现顺序（含嵌套）继续用 shadow root 当 root 再走一趟；
- 只读，零 DOM 副作用。

`isAllowedTextNode(node, rules)` 供 MutationObserver 直接报上来的**游离文本节点**使用：
这类节点没经过 TreeWalker 剪枝，需要自己沿祖先链确认不在导航/页脚/广告/未显示的区域里。

### 3.3 ② 过滤层：四类通用规则（`rules.mjs`）
1. **标签规则** `SKIP_TAGS`：`SCRIPT` `STYLE` `NOSCRIPT` `TEMPLATE` `SVG` `MATH` `CANVAS` `IFRAME`
   `TEXTAREA` `INPUT` `SELECT` `OPTION` `BUTTON` `CODE` `PRE` `KBD` `SAMP` `VAR` `VIDEO` `AUDIO` …
   （选项页开启「翻译界面文案」时只把 `BUTTON` 从集合移除，其余不变）
2. **区域规则** `REGION_SELECTOR`：`header` `nav` `footer` `aside` +
   `[role=navigation|contentinfo|banner|complementary|search|dialog|menu|toolbar|tablist|form]` +
   `[aria-hidden="true"]` `[hidden]` `[translate="no"]` +
   广告/推广/提示条的通用命名启发式（`[class*=advert]` `[data-ad]` `[class*=sponsor]`
   `[aria-label*=advertis]` `[class*=cookie]` `[class*=consent]`）+ 插件自身 `ot-` 命名空间。
   由 `skipNoise` 开关控制（默认开；关掉后连页头/导航也一起翻译）。
   **页头例外**：`isContentHeader` 判定「含 `h1`/`h2` 且不含 `nav` / `[role=navigation]`」的
   `<header>`（含 `[role=banner]`）是**文章标题区**而不是站点骨架，按正文翻译；含导航的顶栏照旧剪掉。
   由 `headerIsContent` 开关控制（默认开）。
3. **可见性规则**：`el.checkVisibility({ displayProperty: true, visibilityProperty: true })`
   （Chrome 105+，一次调用穿透祖先链），没有该 API 时退回 computed style；结果按元素缓存。
4. **文本语义规则** `isTranslatableText`：长度 <2、纯数字/金额/日期、无任何字母、纯 emoji、
   URL 片段、相对时间（`3h` / `· 2d`）、已是目标语言 → 一律不发请求。

四类规则都**不含任何站点名**，`tests/unit/rules.test.mjs` 用断言把这一点钉死
（`REGION_SELECTOR` / `SKIP_TAGS` 里出现 reddit/tindie/ytd- 之类字样即测试失败）。

### 3.4 ③ 合并层：Merge → Translate → Split（`merge.mjs`）

一个句子常被行内标签切成多个 TextNode：
`Please read the ` + `<a>official docs</a>` + ` and press ` + `<b>Send feedback</b>` + ` to continue.`
逐节点翻译会把一句话翻成互不相干的碎片（语序、语气、代词全对不上）。合并层把
**同一个块级容器内、中间只隔着行内内容**的连续文本节点合并成一个单元，请求时用片段分隔符
`U+0001` 保住片段边界，收到译文后按分隔符切回各自节点。

- **容器判定**：`nearestBlockContainer(el, rules)` 取最近的非行内祖先（段落 / 卡片 / 标题），
  判定共用 `INLINE_DISPLAYS` + `displayCache` —— 与回写层的标记落点是同一套语义。
- **屏障扫描**：`scanBarriers` 用 TreeWalker 找出容器内会切断句子的元素（块级盒子、`<br>`、`<hr>`），
  任何屏障两侧的文本绝不合并 —— 两个帖子、两个商品标题、两个段落因此天然分开；
  不译子树（`<img>`/`<video>`/`<select>`/`<input>`…）**不算屏障**，"图片夹在句子中间"照常合并。
  容器元素过多（> 400）时放弃合并，不冒性能风险。
- **上限**：单单元最多 24 个片段 / 1200 字符，超限自动断开成多个单元。
- **拆分校验**：`splitTranslation` 要求「片段数完全相等且无空片段」，否则返回 `null`，
  整组作废并**退回逐节点翻译**（宁可与旧行为一致，也绝不猜着切、绝不错位）。
- **防死循环**：拆分失败的节点进入 `solo` WeakSet，之后永不参与合并；
  下一轮按单节点翻译，不会出现「合并 → 失败 → 再合并」。
- **异常隔离**：单个单元处理异常只影响它自己（`groupErrors`），并把它重排成逐节点，
  绝不会让整批静默失败（`drainErrors` 只记账，永不吞掉）。
- **开关**：`sentenceMerge`（默认开）。关掉后回到纯「一个 TextNode 一个单元」。

### 3.4b ④⑤ 队列层与映射层（`queue.mjs`）
- `push(node, text)`：入队（按节点去重）；`drain()` 单飞回路：取一批（默认 150 个节点）→
  先查缓存 → 剩下的**按文本去重**后交给 `engine.translateMany(texts)` 批量请求。
- 批量只发生在「一次请求里放多条**独立**文本」，引擎层再用 `splitBatchByOrig` 逐句校验行边界，
  边界不可信就退回逐条 —— 绝不把多段文本拼成一条字符串再拆开写回。
- 结果映射：`Map<文本, 节点[]>`，每段文本的译文只写给它自己的那些节点；
  引擎没返回的文本 → 该节点计失败并保持原文，**绝不拿邻近节点的译文顶替**。
- 顺带保证：批次数 × 批大小 = 单元数，单次请求体量受引擎层 32 条 / 3000 字上限约束。

### 3.5 ⑥ 回写层（`writer.mjs`）
- `write(node, translated)`：唯一的写操作 `node.data = 译文`；写前把原文记进 `originals`（`Map<Text, 原文>`）。
- **边界空格**：原文首尾空白（行内片段之间的空格）由 `keepBoundarySpace` 还原，
  避免 `docs` 与 `and` 被粘成一段。句级重建切回的片段额外带 `keepLeading`：
  上一片段已经补过尾部空格时本片段不再补首部空格，行首不会出现两个连续空格。
- **防重复翻译（WeakMap 值比对）**：`written: WeakMap<Text, 译文>` 既是「自己触发的 mutation」的过滤器，
  也是「这个节点已经译过」的判据；页面把节点内容换成新文本后比对立刻失效 → 自动重新翻译。
  等价于需求里的 WeakSet / data-translated 方案，但不往页面塞属性、也不怕标记残留。
- **标记落点**：`data-ot-done` 挂在文本节点「最近的块级祖先」上（段落 / 卡片这一层），
  行内标签（`<b>`/`<span>`）不承担标记；标记只用于人工排查与自动化断言，**从不作为跳过门控**。
- **无损还原**：`restoreAll()` 逐节点写回原文并摘掉 `data-ot-done` / `data-ot-src`，
  关闭整页翻译不再需要刷新页面；`prune()` 回收已摘除节点。

### 3.6 ⑦ MutationObserver 层（`observer.mjs`）
- 一个 `MutationObserver` 同时观察 `documentElement` 与所有 open shadow root
  （`childList` + `subtree` + `characterData`）。
- `childList` → 新增子树去重（丢掉被同批其它根包含的节点）后交给提取层重新走 TreeWalker；
- `characterData` → 原位改写的文本节点（React 复用节点最常见）直接重新翻译；
- 自己写进去的译文由 `writer.isOurs()` 识别并忽略 → 不会出现「翻译 → DOM 变化 → 再翻译」死循环；
- 事件按 180ms 防抖合并，单批上限（300 个根 / 800 个文本节点）之外的交给兜底重扫。

### 3.7 编排层（`translator.mjs`）
- `setEnabled(true)`：重置会话 → 启动 observer → 扫 `document.body` → 启动兜底重扫 → 开抽水；
- `setEnabled(false)`：停 observer → 停重扫 → 清队列 → `writer.restoreAll()` 还原原文；
- **兜底重扫**：只在页面有变动时进行（连续变动约 1.5s 一次，空闲后 10s 一次；
  超过 30s 无变动且队列为空则跳过），用于补 `attachShadow` 晚于扫描、遍历被中断等漏网情况；
- **失败重试**：单条失败放回队列重试一次，连续两次失败保持已入队状态不再重试（离线不会陷入死循环）；
- 状态对象（供面板 / popup / e2e 读取）：`phase / enabled / pending / done / failed / strategy /
  lastScan / shadowRoots / stats{scanned,textNodes,units,unitsDone,cacheHits,cacheMisses,requests,
  mutations,shadowRoots,translates,translateMs,merged,splitFailed,groupErrors,drainErrors}`。

### 3.8 三个历史故障的根因（本次重构解决的东西）
| 现象 | 旧架构根因 | 新架构 |
| --- | --- | --- |
| Reddit 内容被拼成长文本、帖子边界丢失、内容堆到页底 | 单元是「容器 + 子节点区间」，整块文本抽成一条模板发给引擎；token 对不齐时退回纯文本模式，把整段译文写进**第一个**文本节点、其余清空（`applyPlainText`），空槽位还会折进最后一个节点 | 单元 = 单个 TextNode，永远不聚合、不折叠；每个节点只拿自己那段译文 |
| Tindie 多个商品标题被拼进同一个 DOM 节点 | 同上：`buildWrites` 把连续文本槽位合并成一个写入目标（首个节点收全部译文，其余置空） | 每个 TextNode 各自回写，节点数与内容一一对应 |
| 修一个网站坏另一个 / 大量站点特判 | `dom.mjs` 里靠 `shreddit-*`、`ytd-*` 等站点专属选择器和「猜测块级」补丁 | 规则层只有标签/区域/可见性/文本语义四类通用规则，零站点判断 |

补充：句级重建（3.4）不是针对某个站点的修补，而是这次重构**新增**的通用能力。
旧架构的「整块抽取」看似在整句翻译，实际是把多个互不相关节点的文本拼在一起再写回一个节点；
新架构是「同段落内的片段合并 → 整句翻译 → 按片段切回各自节点」，节点身份与写法完全不变。

### 3.9 缓存 / 批量 / 抗风控（沿用）
- **缓存**：键 `sha256(原文) + 目标语言 + 引擎标签`（`src/core/sha256.mjs`，同步纯 JS 实现，
  与 `node:crypto` 逐字节一致）；内存 `Map` + LRU 限额 + `chrome.storage.local` 落盘（`ot-cache-v3`）。
- **请求闸门**：`engines.mjs` 的 `_fetch` 是所有出口请求（Google / Edge / custom / mock，含批量）
  的唯一通道：并发上限 `concurrency`（默认 3）+ 每次请求前随机抖动 `jitterMs`（默认 50~200ms）。
- **批量**：引擎层 `BATCH_MAX_TEXTS = 32` / `BATCH_MAX_CHARS = 3000`；响应逐句校验行边界，
  不可信则本批退回逐条（宁可多花请求，也不错位）。

### 3.10 诊断输出
- 选项页「调试日志」开启后 `console.info('[ot]', ...)` 打印进度；
- `window.__otDebug`（隔离世界）与 `<html data-ot-debug="JSON">` 镜像同一份状态，
  F12 里 `JSON.parse(document.documentElement.dataset.otDebug)` 可直接读取
  `strategy`（恒为 `text-node`）/ `shadowRoots` / `stats`；
- 排查「某个节点为什么没被翻译」：在页面里对目标节点依次检查
  `isSkippableElement`（祖先是否在 `ot-` / 广告 / header 等规则内）、`isTranslatableText`（文本语义）、
  `checkVisibility`（是否可见）三步即可。

### 3.11 为什么新增站点不需要适配代码
提取层只产出 TextNode、回写层只改 `node.data`、规则层只认通用启发式，
所以站点差异只可能以两种方式出现：**渲染时机**（晚加载/无限滚动 → MutationObserver + 兜底重扫覆盖）
和**语义判定**（哪些文字算正文 → 规则层按标签/区域/可见性/文本语义判定）。
两者都不需要站点名判断。新增站点若确实出问题，正确做法是把它归纳成一条**通用规则**
（例如「role=xxx 一律视为非正文」），而不是加 `if (site === 'xxx')`。

## 四、测试方案
1. `npm run unit`：文本判定与切句、sha256（对照 `node:crypto` 及 55/56/64 字节边界）、
   缓存指纹、引擎响应解析、请求闸门并发与抖动，以及本次重构新增的三组策略测试：
   - `rules.test.mjs`：跳过标签 / 非正文区域 / 文本语义四类规则，并断言规则里**不含任何站点名**；
   - `queue.test.mjs`：批量请求里每条文本相互独立、node[i] ← 自己那段译文、同文本去重、
     引擎漏返回时计失败而不顶替、批次切分、已摘除节点丢弃；
   - `merge.test.mjs`：合并层的边界判定（段落/块级盒子/`<br>` 两侧绝不合并、不译子树不切断句子、
     片段数上限、solo 降级），`splitTranslation` 对「吞掉/复制/挪动分隔符」一律返回 null，
     以及队列集成：合并单元一次请求 + 片段各自回写、引擎吞掉分隔符时整组退回逐节点；
   - `writer.test.mjs`：只改 `node.data`、节点列表不变、标记落在块级祖先、原文无损还原、
     双语属性不改变 DOM/排版、行内片段边界空格不丢。
2. `npm run e2e`：Playwright 以有头模式启动开源 Chromium（MV3 扩展不支持 headless），
   加载真实扩展 + 本地 mock 站点与 mock 翻译（mock 提供 Google gtx 形态的批量响应），断言：
   - 整页翻译生效且滚动后不消失；
   - **结构零改动**：整页翻译前后逐节点快照比对（递归含 shadow root）完全一致，
     翻译完成后 3s 内不再发出新请求（防自触发循环）；
   - **结构保真**：`<a>/<b>/<span>/<em>/<img>/<video>/<select>/<input>` 节点身份不变、
     属性与表单状态保留、按钮/链接事件监听仍可用（`tests/e2e/testdata/structure.html`）；
   - **译文对齐**：行内标签开头/中间/整段在标签里三种位置都不错位、不丢字；
   - **批量请求**：请求数远少于翻译单元数；mock 模拟「引擎把多行合并成一句」时自动退回逐条；
   - **大页面护栏**：800 段 × 3 单元 = 2400 个单元在预算内完成（防 O(n²) 扫描回归）；
   - **双语对照**：DOM 逐节点不变，`data-ot-src` 属性 + 伪元素生效；
   - X 模拟：动态追加推文自动翻译、虚拟 DOM 回收后回流译文立即恢复；
   - **Reddit 模拟（shadow DOM）**：`shreddit-post` / `shreddit-comment` / `faceplate-tracker`
     正文、嵌套组件的 shadow root、slot 投射的 light DOM、1.5s 后插入的新评论全部翻译，
     且 shadow 内部节点不变、`shadowRoots ≥ 2`、诊断 stats 存在；
   - 默认跳过 `<button>`（开启「翻译 UI 文案」后才译）；
   - **禁止整页 / 跨帖子合并**（`/feed.html`：`shreddit-feed` 里 3 个帖子 + 侧栏 + 导航 + 页脚）：
     每个标题/段落各自成单元（译文 = 各自的原文，未被拼接）、单次请求里同一行绝不出现两个帖子的文本、
     单次请求体量受控、单元数达段落级、导航与页脚不翻译；
   - **商品网格**（`/tindie.html`：5 张商品卡片 + 页头 + 页脚）：每张卡片的标题/卖家各自翻译、
     价格原样留在自己卡片里、标题绝不被堆到卡片外、单次请求不跨卡片、卡片/图片/标题节点身份不变；
   - **句级重建**（`/structure.html`）：被行内标签切成 5 个文本节点的一句话合并成一个单元发出请求
     （请求里带片段分隔符、片段数 = 文本节点数），译文按片段切回各自节点、子节点与行内标签数量不变、
     整句没有被塞进任何一个节点、不残留分隔符、译文与原文仍然逐字对齐；
   - **分隔符被吞掉的降级**（mock `gtx=dropsep`）：识别出片段边界不可信 → `splitFailed ≥ 1`，
     整组退回逐节点翻译，译文仍然逐字对齐；
   - **页头规则**（`/header.html`）：含 `h1/h2` 且不含 `nav` 的 `<header>` 按正文翻译，
     含导航的顶栏与页脚不翻译，且期间页面 DOM 结构不变；
   - **容器复用 / 流式覆盖**：占位文本先被翻译并打标记，随后页面复用同一容器换入全新文本
     （`textContent` 整体替换、框架新建文本节点、流式追加），这些新文本必须被**重新翻译**，
     且期间插件未插入/搬动任何节点；
   - 类 hackaday 动态站：空容器 + JS 分批延迟注入（innerHTML 注入 / 追加 / 原位改写文本节点）持续翻译到全部出现；
   - iframe：父页面开启整页翻译后，子框架首批与动态新增文本均自动翻译；
   - 划词浮层出现并翻译；
   - **图片翻译不改页面 DOM**：浮层不改页面节点（body 节点数不变、`img` 父节点仍为 `FIGURE`、
     内联样式为空），浮层贴合图片且滚动跟随，一键移除后 DOM 复原。
   离线可用：`providerChain:["google"]` + `hostOverrides.google` 指向本地 mock 的 gtx 端点
   （`/translate_a/single`），不依赖外网。

## 五、使用安装
见根目录 [README.md](README.md)：解压后在 `chrome://extensions` →「加载已解压的扩展程序」选择项目根目录（含 `manifest.json`）即可，无需 npm。

## 六、兼容性检查
| 站点 / 形态 | 关键风险 | 现状 |
| --- | --- | --- |
| React SPA（通用） | 节点增删让 fiber 与真实 DOM 失配 → 白屏 / 布局错乱 | ✅ 全链路只写 TextNode；e2e 已自动断言「翻译前后逐节点快照一致」 |
| Reddit 新版 | open shadow root 漏译；双语 wrapper 搬散 grid 布局；虚拟化回收导致容器换入新文本后永久漏译；多个帖子被并成一段长文本 | ✅ 递归 shadow root + observer；双语改挂属性；单元粒度 = 单个 TextNode（帖子/评论天然各自成单元）；去重按文本节点值比对，容器复用后会重新翻译（e2e 覆盖） |
| X / Twitter | 时间线虚拟化回流、动态插入推文 | ✅ 动态追加自动翻译、回流后译文立即恢复 |
| YouTube | `ytd-*` 同为 shadow DOM；`ytd-watch-next-secondary-results-renderer` 等虚拟列表 | ⚠️ 扫描器已支持 shadow DOM，但未实机跑测试，建议人工验收 |
| 知乎 | 普通 DOM（无 shadow）；答题/评论动态加载 | ⚠️ 走同一条只改文本节点路径；`<button>` 默认跳过；未实机跑测试 |
| 站点顶栏 / 文章标题区 | 「页头一律不翻译」会把文章标题也跳过；「页头一律翻译」会把菜单翻译掉 | ✅ 通用规则：`<header>`/`[role=banner]` 含 `h1`/`h2` 且不含 `nav` → 正文；含导航 → 站点骨架，跳过（零站点判断） |
| 任意新站点 | 需要写适配代码？ | ✅ 不需要：提取层只认 TextNode，回写层只改 `node.data`，规则层只有通用启发式（见 3.11） |

> 说明：内容脚本运行在隔离世界，读不到页面的 `__reactFiber$` / `__reactProps$`
> 等框架内部键，因此本插件**不依赖框架探测**，而是「一律不动页面 DOM」——
> 这对所有框架（React / Vue / Svelte / 原生 Web Component）一致安全。