# OmniTranslate 万译 · 全能网页实时翻译

> 开源免费 · 英→中一键整页翻译（含评论与实时动态）· 只改文本节点、绝不改动网页结构 · 支持 Shadow DOM · 翻译不随滚动消失 · 划词即译 · 点图即译（可选离线 OCR）
> 兼容 X/Twitter、Reddit、Tindie、Indiegogo、hackaday 等几乎所有网站。

> **这个目录是 [ctoe（AI Language Coach）](../README.md) 的一部分。**
> 桌面端通过本机回环协议和这个扩展对接（网页划词/右键 → 桌面端 Learn），所以两边的版本号是同一个：
> 根目录 `npm run build:extension` 会先 `npm run sync:version` 把 `package.json` 的版本写进这里的 `manifest.json`，
> 再构建 `src/ → dist/`。依赖用仓库根部的（不用单独 `npm install`）。
> 本文下面的「打包」「发布」是扩展自身独立分发时用的流程，仍然可用：
> `npm --prefix extension install` → `npm --prefix extension run pack`。

## 快速使用（拿到压缩包后 3 步）

1. 解压得到 `omni-translate` 文件夹（`manifest.json` 必须位于该文件夹根目录）。
2. 打开 Chrome / Edge，访问 `chrome://extensions`，开启右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，**选择解压出的 `omni-translate` 文件夹**（不要选 `dist/`，清单文件在项目根目录）。

加载后把图标固定到工具栏，打开任意英文网站即可使用：
- 右下角悬浮球「译」或快捷键 `Alt+T`：一键整页翻译 / 还原；
- 选中英文即弹出中文（划词翻译）；
- 在浮层开启「图片翻译」后点击图片即可 OCR 翻译图片；
- 快捷键 `Alt+Shift+S`：开关划词浮层。

> 本项目已预置离线 OCR 组件（`vendor/tesseract/`，含 eng/chi_sim/chi_tra 语言包），**无需联网、无需 npm 即可直接使用**。npm 与构建仅面向开发者。

## 特性

- **一键整页翻译 / 还原**：工具栏按钮、页面悬浮球或快捷键 `Alt+T`。
- **翻译不随滚动消失**：一次性翻译整页，而不是只译可见区；滚动加载 / 展开评论 / 无限流新内容由 MutationObserver 自动补译。
- **单元粒度 = 一个文本节点（TextNode）**：用 `TreeWalker` 只收集文本节点，一个文本节点对应一次翻译、对应一次回写。帖子标题、正文片段、每条评论各自成单元，**永远不会把多个帖子 / 多个商品标题拼成一段文本，也不会把多段译文写进同一个节点**（"多个标题挤在一起 / 内容堆到页底"由此从架构上消失）。
- **句级重建（Merge → Translate → Split）**：被行内标签切开的同一句话（`Please read the ` + `<a>official docs</a>` + ` and press …`）会先合并成一个单元**整句翻译**，再按片段分隔符切回各自的文本节点。因此既不会像旧版那样把多段文字拼成一条长文本，也不会把一句话翻成互不相干的碎片；译文语序、语气、代词都能对上。合并范围严格限制在「同一段落内、只隔着行内内容」的文本节点之间，天然不跨帖子、不跨卡片、不跨段落（选项页「句级重建」可关闭）。
- **只翻译正文区域**：默认整棵跳过 `<header>` / `<nav>` / `<footer>` / `<aside>` / 广告 / cookie 提示条等非正文区域，以及脚本、样式、代码块、表单控件；文本语义上再过滤掉纯数字、URL、emoji、"3h" 这类相对时间与已是目标语言的内容（选项页「只翻译正文区域」可关闭，关掉后连页头导航一起翻译）。另外，**页头里含主标题（`h1`/`h2`）且不含导航时按正文翻译** —— 很多博客/文档站的文章标题就在 `<header>` 里；含导航的站点顶栏仍然跳过（选项页可关闭该例外）。
- **翻译不改动网页结构**：只改写原来的文本节点，`<a>` / `<img>` / `<input>` / `<video>` / `<select>` 等元素从不重建、从不删除；事件监听、表单输入内容、`<img alt>`、React/Vue 持有的 DOM 与页面样式全部保留。
- **硬不变式：翻译前后 DOM 逐个节点比对完全一致**：整条链路只允许 `textNode.data = 译文`，不使用 `innerHTML` / `outerHTML` / `innerText` / `body.textContent` / `insertBefore` / `appendChild` / `remove` / `replaceWith` / `insertAdjacentHTML`，不新建、不删除、不移动任何节点，也不改任何 `display / flex / grid / position`。React 页面最怕的 `removeChild` 错位（白屏）由此从根上消失（e2e 会逐节点快照比对）。
- **Shadow DOM / Web Component**：递归进入 open shadow root（含嵌套组件），Reddit 新版 `shreddit-post` / `shreddit-comment` / `faceplate-tracker` 以及 YouTube 的 `ytd-*` 这类正文写在组件阴影树里的站点同样能整页翻译；`MutationObserver` 同时挂在 shadow root 上，无限滚动新插入的组件会自动补译。
- **译文与原文严格对齐**：回写只认「这个节点自己的那段译文」，引擎漏返回就记失败并保留原文，**绝不拿邻近节点的译文顶替**；原文首尾空白会原样保留，行内片段拼接后与原文逐字一致（不会出现「对不上 / 乱码 / 单词粘连」）。
- **批量翻译，明显更快**：多条文本合并进一次请求（响应按每行原文校验边界，对不齐自动退回逐条），请求数约为逐条翻译的 1/16；整页扫描改为 O(n)，页面空闲时不再每秒全页重扫。
- **动态站点（hackaday、X、Reddit 等）**：MutationObserver 同时监听新增子树、新增文本与文本原位改写（characterData），"初始只有空容器、正文由 JS 延迟注入"的页面照常翻译；另有按需兜底重扫（页面变动时约 1.5s 一次，空闲 30 秒后停止，不空转）。同一内容再次插入时从本地指纹缓存 0ms 恢复，不重译、不闪烁。
- **容器复用自动重译（Reddit 虚拟化专项）**：去重不靠任何 DOM 属性/标记，而是按「文本节点当前值 === 我们上次写入的译文」比对。所以页面回收复用同一个容器、把里面换成全新文本（React 重建子树、评论区虚拟化、流式追加）时，比对自动失效并**重新翻译**；不会像旧版那样被 `data-ot-done` 永久挡掉而大片漏译。
- **iframe 子框架**：`manifest` 以 `all_frames` 注入，iframe 内的评论/动态/正文随整页翻译一起开启；悬浮 UI 只在主页面出现，不会在每个框架里重复。
- **划词翻译**：鼠标选中英文即弹中文；跨行、跨标签的句子自动合并整句翻译；可固定小卡、一键复制、`Esc` 关闭。
- **图片翻译（可选）**：开启「图片翻译」或对图片右键「翻译此图片」。点击图片 → 本地 Tesseract OCR → 图片底部统一翻译框（合并为普通文本、14px 自动换行、半透明黑底白字、不按 OCR 坐标排版，随图片滚动缩放不错位）；可「译文 / 原图」切换、✕ 一键还原。翻译浮层挂在插件自己的层级里按图片位置绝对定位，**不会把 `<img>` 搬进新容器、也不改图片内联样式**，React 页面同样安全。每张图需主动点击，不做全站自动扫描，保护隐私。
- **两种显示方式**：「仅译文」和「双语对照」（原文 + 译文逐块对照）。
- **多免费引擎自动降级**：Google 免费端点优先，失败自动切换 Microsoft Edge 公共端点（新版无鉴权接口）；自动记住可用的最快引擎、失效引擎快速熔断切换，也可配置任意 OpenAI 兼容或自建翻译 API。
- **界面文案可选翻译**：默认只翻译正文（跳过 `<button>` / `<input>` 等交互控件），需要时在选项页开启「翻译按钮/导航等界面文案」。
- **抗风控的请求调度**：全局并发上限（默认 3）+ 每次请求 50~200ms 随机抖动，请求数经批量合并后约为逐单元请求的 1/16；命中本地指纹缓存（`sha256(原文)`）不发请求。
- **诊断输出**：`JSON.parse(document.documentElement.dataset.otDebug)` 可读出扫描节点数 / 文本节点数 / 单元数 / 缓存命中 / 请求数 / MutationObserver 次数 / 已接入 shadow root 数 / 翻译耗时；选项页开启「调试日志」还会在 Console 打印 `[ot]` 进度。

## 图片翻译（离线 OCR）

仓库已预置离线 OCR 组件（`vendor/tesseract/`：识别核心 + `eng` / `chi_sim` / `chi_tra` 语言包），加载即用、无需联网。选项页 → 图片 OCR 中可配置：

- 识别语言：`eng`（英文）、`chi_sim`（简体）、`chi_tra`（繁體）；中英混排可填 `eng+chi_sim`；
- 识别模式：`Tesseract（本地离线）` 为默认；`Mock（测试）` 仅用于离线自动测试。

若换机或丢失语言包，可重新生成：

```bash
npm install
npm run fetch-ocr   # 下载 worker/core 与 eng/chi_sim/chi_tra 语言包到 vendor/tesseract
npm run build       # 重新构建 dist/
```

## 站点兼容

- 所有 http/https 页面自动注入；正文、标题、按钮、评论区统一翻译。
- **hackaday.io/myFeed 类动态页**：空容器 + JS 延迟注入可正常整页翻译；内容如果在 iframe 中同样生效。（注意：`myFeed` 需先登录，未登录会跳到登录页。）
- **X / Twitter**：实时时间线自动补译；虚拟化回收后重新插入同一推文时立即恢复译文。
- **Reddit 首页 / 列表**：按帖子、按段落独立翻译，不再把多个帖子和导航/页脚拼成一长段（回归测试覆盖）。
- **Reddit**：嵌套回复、点击「加载更多评论」后的新评论自动翻译；评论区虚拟化回收复用容器、换入全新评论文本后同样会重新翻译（回归测试覆盖）。
- **Reddit 新版（React + Web Component）**：`shreddit-post` / `shreddit-comment` / `faceplate-tracker` 的 shadow DOM 正文、slot 投递的 light DOM 标题一并翻译；插件不搬动任何节点，不会再出现"主体空白 / 文本堆到底部 / 布局错乱"。
- **Tindie / Indiegogo / Kickstarter 等众筹与商城页**：描述、更新、评论、进度文案一并翻译；商品网格里每张卡片的标题 / 卖家 / 价格各自留在自己的卡片里（旧版会把整页标题拼成一段写进第一个节点，现象就是「标题全挤在图片上方一行」）。
- **通用规则引擎，零站点适配**：代码里没有任何站点名判断（不存在 `if (reddit)` / `if (tindie)` 之类的分支），所有网站走同一条「提取文本节点 → 过滤 → 合并（句级重建） → 翻译队列 → 映射 → 回写」流水线。新增站点通常无需任何改动。
- 遇到仍无法整页翻译的站点，可先用划词翻译应急；并在该页 `F12 → Console` 执行 `JSON.parse(document.documentElement.dataset.otDebug)` 查看翻译状态（phase / pending / done / failed / lastScan / mode / strategy / chain / shadowRoots / stats）反馈给我们，方便快速定位。
  - 若问题在 iframe 里，先在 Console 左上角的上下文下拉框选中对应子框架再执行同一句。
  - `window.__otDebug` 只在扩展的隔离世界中存在，页面 Console 默认看不到；要读它需把上下文切到对应的扩展（content script）世界。

## 常见问题

- **修改/更新扩展后不生效？** 到 `chrome://extensions` 对该扩展点「刷新」，再按 `Ctrl+F5` 强刷网页。
- **翻译引擎失效或整页不动？** 微软已在 2025–2026 年下线旧版 Edge 免费翻译流程（`edge.microsoft.com/translate/auth` 返回 404），本版已改为新版无鉴权公共端点并自动纠正旧地址；大陆网络不可达 Google 时引擎会先探测再快速切换到 Edge。若仍异常，可到选项页关闭失效引擎或填写自定义 API；多引擎会自动降级。
- **只想译一部分？** 划词翻译默认开启；也可在选项页关闭「整页自动翻译相关开关」按需使用。
- **Reddit 有些区块一直没被翻译？** 旧版把 `data-ot-done` / `data-ot-skip` 当作「整棵子树跳过」的门控，而 Reddit 评论区是虚拟化列表、会回收复用同一个容器并换入全新文本 —— 容器一旦译过就被永久拉黑，表现就是「大片没译、效果很差」。本版已取消全部属性门控，改为按文本节点值比对去重（容器内容一变即自动重译），并加了对应的自动化回归测试。升级后请刷新扩展 + `Ctrl+F5`。
- **整页被拼成一大段长文本（多个帖子 / 导航 / 页脚连在一起）？** 这是旧架构的问题：它按「容器 + 子节点区间」整块抽取文字，一个 feed 可能被并成一条模板，token 对不齐时还会把整段译文写进第一个文本节点。本版已改成**文本节点级流水线**（单元 = 单个 TextNode，逐节点回写），默认过滤页头 / 导航 / 页脚 / 广告，并有自动化回归测试断言"请求里绝不出现两个帖子的文本"。升级后请刷新扩展 + `Ctrl+F5`。
- **升级后页头标题变成译文了？** 这是本次新增的通用规则：`<header>` 里**含主标题（`h1`/`h2`）且不含导航**时属于文章标题区，按正文翻译；含导航的站点顶栏仍然跳过。如果你更希望页头一律不翻译，到选项页取消勾选「页头含主标题（h1/h2）且不含导航时，按正文翻译」即可。
- **被行内标签切开的句子现在整句翻译了？** 这是「句级重建」（Merge → Translate → Split）：同一段落内只隔着行内标签的文本节点会合并成一个单元整句翻译，再按片段切回各自的文本节点，节点身份与子节点数完全不变。想回到逐节点翻译，到选项页取消勾选「句级重建」即可。
- **翻译慢 / 译文对不上 / 网页被改乱？** 本版已修复这三类问题：回写只有 `node.data = 译文` 一种操作（结构、事件监听、表单状态全部保留）；每段文本只写回它自己的节点，引擎漏返回就保留原文而不是拿别的译文顶替；多条独立文本合并成一次批量请求，兜底重扫只在页面有变动时进行（空闲自动停）。升级后请到 `chrome://extensions` 刷新扩展，再 `Ctrl+F5` 强刷网页。
- **Reddit 翻译后布局错乱 / 主体空白 / 文字堆到底部？** 这是旧版「双语对照把整块容器搬进新建 wrapper」和「首槽位没有文本节点时补建 TextNode」造成的：React 的 fiber 树与真实 DOM 对不上，随后 `removeChild` 抛错就会白屏。本版已彻底移除这两处结构改动（双语对照改为 `data-ot-src` + CSS 伪元素；空槽位改为并入相邻已有文本节点），并加了"翻译前后 DOM 逐个节点比对一致"的自动化测试。若仍看到问题，请刷新扩展后 `Ctrl+F5` 强刷页面，并把 `JSON.parse(document.documentElement.dataset.otDebug)` 的输出发给我们。

## 开发与测试

需要先安装依赖：

```bash
npm install
npm run build   # esbuild 打包 src/ → dist/
npm run pack    # 打包成可分发的 zip（release/OmniTranslate-v*.zip），详见「打包与分发」
npm run unit    # 纯逻辑单测（文本判定/切句/sha256 指纹/引擎解析/规则层策略/队列映射/回写层不变式）
npm run e2e     # Playwright 启动开源 Chromium 加载扩展，跑本地 mock 站与 mock 翻译
```

每个文件/模块负责什么、一条翻译请求从网页文字到译文经历了哪几步、以及「想改 X 该动哪个文件」，
见 [ARCHITECTURE.md](ARCHITECTURE.md)。

e2e 覆盖：划词翻译、整页 ≥24 段、滚动后译文不消失、**结构保真**（节点身份 / 属性 / 表单状态 / 事件监听不变）、**整页翻译前后 DOM 逐节点比对完全一致**（无新增 / 删除 / 移动 / 替换）、**双语对照同样零结构改动**（无 `.ot-zone`，原文走 `data-ot-src` 伪元素）、**译文对齐**（行内标签在句首 / 句中 / 整段都不错位、不丢字）、**批量请求**（请求数远少于翻译单元数，含引擎把多行合并时自动退回逐条）、**翻译完成后不再重复请求**（防死循环）、**大页面护栏**（800 段 × 3 单元 = 2400 个单元在预算内完成）、X 实时新增推文自动翻译、虚拟 DOM 回收回流恢复、Reddit 深层评论与加载更多、**Shadow DOM**（`shreddit-post` 阴影正文 / 嵌套组件 / slot 投递的 light DOM / 无限滚动新增组件，且 shadow 内部节点不变）、**容器复用 / 流式覆盖**（占位文本译过之后，页面回收复用同一容器换入全新文本仍会被重新翻译，且期间不插入/搬动任何节点）、**禁止整页 / 跨帖子合并**（`shreddit-feed` 内 3 个帖子 + 侧栏 + 导航 + 页脚：每个标题/段落各自成单元、单次请求同一行不出现两个帖子的文本、请求体量受控、单元数达段落级、导航与页脚不翻译）、类 hackaday 动态站（空容器 + JS 分批延迟注入 feed 持续翻译）、iframe 子框架文本随整页翻译同步（含动态新增）、点图 OCR → 图内底部统一翻译面板（合并文本 / 固定字号 / 滚动跟随 / 切换还原 / 不改动图片 DOM）、**商品网格**（`/tindie.html`：每张卡片的标题/卖家/价格各自留在自己的卡片里、标题不被堆到卡片外、单次请求不跨卡片、节点身份与子节点数不变）、**句级重建**（被行内标签切开的一句话合并成一个单元发出请求、译文按片段切回各自节点、整句没有被塞进任何一个节点、不残留分隔符）、**分隔符被吞掉的降级**（mock `gtx=dropsep`：识别边界不可信 → 整组退回逐节点，译文仍逐字对齐）、**页头规则**（`/header.html`：含 `h1/h2` 且不含 `nav` 的页头按正文翻译，含导航的顶栏与页脚不翻译，且 DOM 结构不变）、React 标记图片不被搬动。离线可用：`providerChain:['google']` + `hostOverrides.google` 指向本地 mock 的 gtx 端点（`/translate_a/single`），不依赖外网；测试里把 `requestJitterMs` 设为 `[0,0]` 关闭随机抖动。

## 项目结构

```
omni-translate/                ← 「加载已解压的扩展程序」选择此目录（含 manifest.json）
├── manifest.json              MV3 清单（host 权限、快捷键、CSP、all_frames）
├── dist/                      构建产物（content.js、content.css、sw.mjs、popup/options/offscreen、icons）
├── src/
│   ├── content.js             内容脚本入口（esbuild 打包为 IIFE）
│   ├── core/                  提取 text-nodes / 过滤 rules / 合并 merge / 队列+映射 queue / 回写 writer /
│   │                          观察 observer / 编排 translator（另含 settings cache text engines
│   │                          selection image panel misc）
│   ├── background/            Service Worker（消息路由、帧同步、离屏 OCR 调度、右键菜单、快捷键）
│   ├── offscreen/             Tesseract OCR 离屏文档
│   ├── popup/  options/      工具栏弹窗与设置页
│   ├── ui/  assets/          样式与静态资源
├── vendor/tesseract/          离线 OCR 组件与 eng/chi_sim/chi_tra 语言包
├── tests/
│   ├── unit/                  node:test 纯逻辑测试
│   └── e2e/                   Playwright + 本地 mock 站点与翻译服务
├── tools/gen-icons.mjs        图标生成
├── tools/package.mjs          打包脚本（生成 release/ 下的分发 zip）
├── build.mjs  fetch-ocr.mjs   构建与 OCR 组件下载脚本
├── release/                   打包产物（omni-translate/ 目录 + OmniTranslate-v*.zip，已 gitignore）
├── README.md  DESIGN.md  ARCHITECTURE.md  LICENSE  package.json
```

> `node_modules/` 仅开发需要，分发给使用者时不需要包含；使用者直接“加载已解压的扩展程序”即可。

## 打包与分发

把扩展发给别人（对方不需要装 Node，也不需要看源码）：

```bash
npm run pack     # = build + 校验 + 打包（加 --no-build 可跳过构建）
```

产物在 `release/`：

- `release/omni-translate/` —— 解压后的样子，也正是 Chrome「加载已解压的扩展程序」要选的目录（可以先自己试装一次）；
- `release/OmniTranslate-v<版本>.zip` —— 发给别人的文件，内部顶层目录就是 `omni-translate/`。

包内只有运行所需的东西：`manifest.json`、`dist/`（构建产物）、`vendor/tesseract/`（离线 OCR 与语言包），
加上 `README.md` / `DESIGN.md` / `ARCHITECTURE.md` / `LICENSE` 和给收件人看的 `使用说明.txt`（UTF-8 带 BOM，记事本直接打开不乱码）；
**不含** `src/`、`tests/`、`tools/`、`node_modules/`。

写 zip 之前脚本会先校验：按 `manifest.json` 核对它引用的每个文件是否都在包里，并确认离线 OCR 组件
（tesseract 主脚本 / worker / wasm 核心 / 英文语言包）齐全 —— 不会出现「发出去才发现缺文件」；
zip 写完后还会回读，逐条目校验 CRC 与内容哈希。

想确认解压出来的目录真能跑（而不是只看打包日志）：

```bash
npm run verify:pack   # 打包后用 e2e 加载 release/omni-translate/，跑一遍完整断言（会打开一个 Chromium 窗口）
```

也可以让 e2e 去加载任意一个目录：PowerShell 里 `$env:OT_EXT_PATH="D:\path\to\ext"; npm run e2e`。

## 配合 AI Language Coach 桌面端使用

OmniTranslate 还能当「句子入口」：桌面端 **AI Language Coach** 负责翻译、分析和长期学习记录，
扩展只负责把你选中的那句送过去。

1. 打开桌面端 AI Language Coach →「设置 → 浏览器连接」，开启开关并点「复制口令」；
2. 打开本扩展设置页 →「连接 AI Language Coach 桌面端」，粘贴口令，点「连接」；
3. 在任意网页划词：**按住 Ctrl+Shift（macOS 是 Cmd+Shift）** 选中一句话，浮层底部会出现「学习这句」，点一下就完成；或者直接**右键选中的文字 → 「发送到 AI Language Coach（学习这句）」**，结果会显示在页面右下角。

说明：

- 只有你主动点击才会发送，不自动、不后台、不上传整页内容；
- 扩展不保存任何学习数据，句子全部存在本机桌面端；
- 桌面端没启动时浮层只会提示去启动，其它翻译功能完全不受影响；
- 只走本机回环地址（127.0.0.1），不经过任何服务器；
- 想在桌面端撤销这台浏览器的授权，重置一次口令即可。

## 隐私与数据

- 仅在你开启翻译后，把需要翻译的文本片段发给所选翻译服务；图片仅在你点击后才 OCR。
- 本地仅保存设置与翻译结果指纹缓存（可随时在选项页清除）；缓存不离开本机。

## License

MIT，见 [LICENSE](LICENSE)。完整设计思路见 [DESIGN.md](DESIGN.md)。
