# OmniTranslate 文件架构与关键程序说明（备注版）

> 这份文档回答两个问题：**每个文件是干什么的**、**一条翻译请求从网页文字到译文回到底经历了什么**。
> 改代码前请先看「硬不变式」一节 —— 那里写着这个项目绝对不能碰的东西。

## 一、一条翻译的完整链路

所有网站共用同一条链路，代码里**没有任何站点名判断**（不存在 `if (reddit)` / `if (twitter)` 这类分支），
所以新增网站不需要适配代码。

```
网页 DOM
  → ① 提取   collectTextNodes()   用 TreeWalker 只收集文本节点（TextNode）        text-nodes.mjs
  → ② 过滤   rules + shouldTranslateText()  标签/区域/可见性/文本语义四类通用规则   rules.mjs  text.mjs
  → ③ 合并   buildGroups()        同一段落内、只隔着行内标签的连续文本合成一个单元  merge.mjs
  → ④ 队列   TranslateQueue       攒批（默认 150 单元一批）+ 去重 + 并发控制        queue.mjs
  → ⑤ 引擎   TranslateEngine      Google / Edge / 自定义接口，批量请求 + 失败降级   engines.mjs（经 translator.mjs）
  → ⑥ 映射   unit → textNode      只认「这个节点自己那段译文」，绝不用邻居的顶替     queue.mjs
  → ⑦ 回写   node.data = 译文     整条链路唯一的写操作，只动文本节点                writer.mjs
  → ⑧ 观察   DomWatcher           新插入/被原地改写的文本回到 ①，自己写的译文忽略   observer.mjs
```

编排这一切的是 `src/core/translator.mjs` 里的 `PageTranslator`（整页翻译状态机）；
它在每个网页 frame 里各有一份实例，由内容脚本入口 `src/content.js` 装配。

## 二、目录结构（带备注）

```
omni-translate/
├── manifest.json              MV3 清单。只引用 dist/ 与 vendor/ 两个目录 —— 改源码后必须重新构建
├── dist/                      ★ 构建产物（唯一被浏览器加载的代码），由 build.mjs 生成，不要手改
│   ├── content.js             内容脚本（src/content.js + core/ 全部打包成 IIFE）
│   ├── content.css            注入网页的样式（悬浮球/面板/划词卡/图片浮层）
│   ├── sw.mjs                 后台 Service Worker（消息路由、帧同步、OCR 调度、快捷键、右键菜单）
│   ├── offscreen.html/.mjs    离屏文档：跑 Tesseract OCR（内容脚本里加载不了 wasm worker）
│   ├── popup.html/.js         工具栏弹窗：整页翻译开关 / 模式 / 划词 / 图片 / 引擎自测
│   ├── options.html/.js       设置页：语言、引擎链、正文范围、句级重建、OCR、调试
│   └── icons/                 16/32/48/128 图标（构建时由 tools/gen-icons.mjs 画出来）
│
├── src/                       ★ 源码（esbuild 的输入）
│   ├── content.js             内容脚本入口：装配整页翻译 / 悬浮面板 / 划词 / 图片翻译 + 消息路由
│   ├── background/
│   │   └── service-worker.mjs 后台：设置落盘、快捷键与右键菜单、帧同步、跨域取图、OCR 调度、引擎自测
│   ├── offscreen/
│   │   ├── main.mjs           离屏 OCR：加载 vendor/tesseract，识别图片并返回「文本行 + bbox」
│   │   └── offscreen.html     离屏文档壳
│   ├── popup/  options/       弹窗与设置页（main.mjs 只管读写设置 + 给内容脚本发消息）
│   ├── ui/
│   │   └── content.css        注入网页的全部样式（插件自己的 UI 都带 .ot-ui 前缀，避免污染页面）
│   ├── assets/                静态资源占位目录
│   └── core/                  ★ 翻译内核，与 UI 无关，可以单独拿去做单测
│       ├── translator.mjs     编排层：整页翻译状态机（开关、模式、兜底重扫、状态上报）
│       ├── text-nodes.mjs     提取层：TreeWalker 收集文本节点 + 目标语言判定前置过滤
│       ├── rules.mjs          规则层：标签/区域/可见性/行内盒判断（跳过导航、页脚、代码块、表单…）
│       ├── text.mjs           文本层：清洗、切句、纯数字/URL/emoji/相对时间判定、批量分块
│       ├── merge.mjs          合并层：Merge → Translate → Split（把被行内标签切开的一句话整句翻译）
│       ├── queue.mjs          队列层：攒批、去重、并发、单元↔文本节点的映射
│       ├── engines.mjs        引擎层：Google gtx / Edge / 自定义接口 / mock，批量打包与自动降级
│       ├── cache.mjs          缓存层：译文缓存（内存 + 可选落盘节流），避免重复请求
│       ├── writer.mjs         回写层：唯一动 DOM 的地方，且只写 node.data
│       ├── observer.mjs       观察层：MutationObserver（含所有 open shadow root）驱动动态站补译
│       ├── selection.mjs      划词翻译浮层
│       ├── image.mjs          图片翻译：点图 → OCR → 图片上方的翻译浮层（绝不搬动 <img> 节点）
│       ├── panel.mjs          页面右下角悬浮球 + 控制卡（插件 UI 全部用 DOM API 构建）
│       ├── settings.mjs       设置字段与默认值（DEFAULT_SETTINGS 是唯一字段来源）+ 读写 chrome.storage
│       ├── bridge.mjs         AI Language Coach 桥接客户端（只走 127.0.0.1，只在 SW 里发请求）
│       ├── sha256.mjs         同步 SHA-256：给译文缓存做键（旧版短指纹会串号）
│       └── misc.mjs           通用小工具：el() 建 DOM、clearChildren()、debounce/throttle、视口
│
├── vendor/tesseract/          ★ 离线 OCR 组件（tesseract.js + wasm 核心 + eng/chi_sim/chi_tra 语言包）
│                                由 fetch-ocr.mjs 预置；体积约 20 MB，是压缩包里的主要体积来源
├── tools/
│   ├── gen-icons.mjs          纯 JS 画 PNG 图标（自带极简 PNG 编码器，无依赖）
│   └── package.mjs            ★ 打包脚本：构建 → 校验 → 写 release/omni-translate/ + 分发 zip
├── tests/
│   ├── unit/                  node:test 纯逻辑单测（文本规则/切句/哈希/引擎解析/队列/回写不变式）
│   └── e2e/                   Playwright + 本地 mock 站与 mock 翻译服务，验证真实浏览器里的行为
├── build.mjs                  esbuild 构建：src/ → dist/（content 打成 IIFE，其余 ESM）
├── fetch-ocr.mjs              下载并预置离线 OCR 组件到 vendor/tesseract/
├── README.md                  面向使用者：特性、安装、常见问题
├── DESIGN.md                  设计文档：为什么这么设计、踩过哪些坑
└── release/                   打包产物（omni-translate/ 目录 + OmniTranslate-v*.zip），已 gitignore
```

## 三、关键程序逐个说明

### 入口层

| 文件 | 关键导出 | 备注 |
| --- | --- | --- |
| `src/content.js` | —（自执行 boot()） | 每个 frame 跑一份。顶层多挂一个悬浮面板；iframe 只做文本翻译，靠 SW 的 `ot-frame-set` 广播或自己的 `ot-frame-query` 同步开关。调试状态镜像到 `<html data-ot-debug>`（内容脚本在隔离世界，页面主世界读不到）。 |
| `src/background/service-worker.mjs` | —（事件驱动） | 六件事：设置落盘、快捷键/右键菜单、帧同步（`activePageTabs`）、跨域取图转 base64、OCR 调度、引擎自测。MV3 的 SW 会被休眠回收，内存态丢失属已知取舍。 |
| `src/popup/main.mjs` | — | 只做「读设置 / 写设置 / 给当前 tab 发 `cmd` 消息」，翻译逻辑一行都不在这里。 |
| `src/options/main.mjs` | — | 表单 ↔ `settings.mjs` 的映射；保存后内容脚本下次翻译就生效，不用重装扩展。 |

### 内核层（按数据流顺序）

| 文件 | 关键导出 | 备注 |
| --- | --- | --- |
| `src/core/translator.mjs` | `PageTranslator` | 状态机：`init()` / `setEnabled()` / `setMode()`；负责兜底重扫（页面安静时降频，避免每秒全页重扫）、状态上报给面板与弹窗。 |
| `src/core/text-nodes.mjs` | `collectTextNodes()` `isAllowedTextNode()` | 只用 `TreeWalker` 收集文本节点，不做「容器整体抽取」，所以两个帖子/两张卡片绝不会被拼成一段。 |
| `src/core/rules.mjs` | `buildRules()` `isTranslatableText()` `nearestBlockContainer()` 等 | 四类通用启发式：标签、区域（header/nav/footer/aside/广告/Cookie 条）、可见性、行内盒判断。页头含 `h1/h2` 且不含 `nav` 时按正文翻译。 |
| `src/core/text.mjs` | `shouldTranslateText()` `chunkText()` `scriptStats()` `hashText()` | 文本语义过滤（纯数字、URL、emoji、`3h` 这类相对时间、已是目标语言）与批量分块。 |
| `src/core/merge.mjs` | `buildGroups()` `splitTranslation()` | 句级重建。用片段分隔符把整句译文切回各节点；边界不可信时整组退回逐节点（宁慢不错）。 |
| `src/core/queue.mjs` | `TranslateQueue` `QUEUE_BATCH` | 攒批 + 去重 + 并发；维护「单元 ↔ 文本节点」映射，回写时按原文逐条校验。 |
| `src/core/engines.mjs` | `TranslateEngine` `packBatches()` `splitBatchByOrig()` `parseGoogleGtxDetailed()` 等 | 引擎链自动降级：记住最快引擎、失败快速切换；批量响应按原文逐行校验，对不齐就退回逐条。 |
| `src/core/cache.mjs` | `TranslateCache` | 键是原文的 SHA-256；命中缓存直接复用，e2e 断言请求数就靠它。 |
| `src/core/writer.mjs` | `TextWriter` `keepBoundarySpace()` | 唯一的写操作：`node.data = 译文`；原文首尾空白原样保留；引擎漏返回就记失败保留原文。 |
| `src/core/observer.mjs` | `DomWatcher` | 同时观察 document 与所有 open shadow root；`characterData` 变化（React 复用节点）也会触发重译；自己写的译文用 `isOurs()` 忽略，避免死循环。 |
| `src/core/selection.mjs` | `SelectionTranslator` | 划词浮层：选区稳定后取词翻译，可固定（pinned）。 |
| `src/core/image.mjs` | `ImageTranslator` | 点图 → 取图（跨域交给后台）→ 离屏 OCR → 在图片位置上方盖一层翻译浮层。**绝不把 `<img>` 搬进自己的容器**（旧做法会让 React 白屏）。 |
| `src/core/panel.mjs` | `Panel` | 右下角悬浮球 + 控制卡，全部用 DOM API 构建（无 innerHTML）。 |
| `src/core/settings.mjs` | `DEFAULT_SETTINGS` `loadSettings()` `sanitizeSettings()` `LANGS` | 设置字段的唯一来源；新增设置项先在这里加默认值，再改设置页。 |
| `src/core/sha256.mjs` | `sha256Hex()` | 同步纯 JS 实现（隔离世界用不了异步的 `crypto.subtle`）。 |
| `src/core/misc.mjs` | `el()` `clearChildren()` `debounce()` `throttle()` | 最底层工具，UI 一律用它建 DOM。 |

### OCR 链路

```
点图片 (image.mjs) → 后台取图转 base64 (service-worker.mjs ot-fetch-image)
  → 离屏文档 (src/offscreen/main.mjs) 加载 vendor/tesseract → 返回「文本行 + bbox」
  → 逐行翻译 → 盖在图片位置上的浮层里显示（尺寸/位置跟随图片的 getBoundingClientRect）
```

## 四、硬不变式（改代码前必读）

1. **只写文本节点**：整个链路只有 `node.data = 译文` 一种写入。不新增、不删除、不移动任何节点，
   不用 `innerHTML` / `outerHTML` / `innerText` / `replaceWith` / `insertAdjacentHTML`，
   也不改任何 `display / flex / grid / position`。React/Vue 页面最怕的 `removeChild` 错位（白屏）由此从架构上消失。
2. **不改动网页结构就能双语对照**：原文走 `data-ot-src` + CSS 伪元素，不新建 `.ot-zone` 容器。
3. **插件自己的 UI 与页面隔离**：所有 UI 都挂在 `<html>` 下的独立层里，类名一律 `ot-` 前缀 / `.ot-ui`。
4. **`dist/` 是生成物**：所有修改都改 `src/`，然后 `npm run build`。手改 `dist/` 会在下次构建时被覆盖。
5. **任何「为了省事而搬动页面节点」的想法都要放弃**，那是这个项目历史上最大的一次事故来源。
6. **发给桌面端的请求只在 Service Worker 里发**：内容脚本受页面 CSP（`connect-src`）约束，
   且页面一跳转就被销毁；浮层只用 `chrome.runtime.sendMessage` 交给 SW，由 SW 去访问 `127.0.0.1`。
   桥接协议实现在 `src/core/bridge.mjs`（不碰 chrome.*、不碰 DOM，可单测）。

## 五、常见改动该动哪个文件

| 想做的事 | 改哪里 |
| --- | --- |
| 新增一个翻译引擎 | `src/core/engines.mjs`（加 provider + 解析函数）→ `src/options/options.html` 加勾选 → `settings.mjs` 的默认 `providerChain` |
| 新增跳过区域（例如某种弹窗） | `src/core/rules.mjs`：区域选择器 `REGION_SELECTOR` 或 `SKIP_TAGS` |
| 调整「哪些文字不翻译」 | `src/core/text.mjs` 的 `shouldTranslateText()`（记得补 `tests/unit/text.test.mjs`） |
| 改悬浮球/面板外观 | `src/core/panel.mjs` + `src/ui/content.css` |
| 改图片翻译浮层 | `src/core/image.mjs`（样式在 `content.css` 里 `.ot-img-*`） |
| 加设置项 | `src/core/settings.mjs` 加默认值 → `src/options/options.html` + `main.mjs` 加表单 →（需要的话）`sanitizeSettings()` |
| 改快捷键 / 右键菜单 | `manifest.json` 的 `commands` + `src/background/service-worker.mjs` |
| 改浏览器连接（AI Language Coach） | `src/core/bridge.mjs`（协议客户端）+ `service-worker.mjs` 的三个消息（`ot-bridge-status` / `ot-bridge-pair` / `ot-learn-sentence`）+ 右键菜单 `ot-learn-selection` + `src/core/selection.mjs` 的浮层按钮与回执 |
| 改桥接的协议本身 | 两边一起改：桌面端 `src/shared/types/bridge.ts` ↔ 扩展 `src/core/bridge.mjs`（常量必须一致，`tests/unit/bridge.test.mjs` 会报警） |

## 六、构建、测试与打包

```bash
npm install            # 只有开发者需要 Node
npm run build          # src/ → dist/（改完源码必须跑）
npm run fetch-ocr      # 预置离线 OCR 组件到 vendor/tesseract/（缺失时图片翻译不可用）
npm run unit           # 纯逻辑单测
npm run e2e            # Playwright 起开源 Chromium 加载扩展，跑真实页面断言
npm run pack           # 构建 + 校验 + 生成 release/omni-translate/ 与 release/OmniTranslate-v*.zip
npm run verify:pack    # 打包后直接拿 e2e 验证「解压出来的目录」（会开一个 Chromium 窗口）
```

打包细节见 `tools/package.mjs`：包内只有 `manifest.json` + `dist/` + `vendor/tesseract/` + 文档 + `使用说明.txt`，
不含 `src/` `tests/` `tools/` `node_modules/`；写出 zip 后会回读校验每个条目的 CRC 与内容哈希。
