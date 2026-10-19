# 代码结构

> 本文是 [README](../README.md) 的延伸。读完能知道每一层负责什么、一次请求怎么走、改东西该动哪个文件。

## 三层 + 一条铁律

```
┌──────────────────────────── src/renderer ────────────────────────────┐
│  React 页面 / 组件 / hooks。只跟 preload 暴露的 window.api 说话。     │
│  不联网、不读写文件、拿不到 API Key。                                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ window.api.*（contextBridge 暴露的唯一 API 面）
┌───────────────────────────────┴──────────────────────────────────────┐
│  src/preload/index.ts   把 IPC 通道包成 Promise / 订阅，没有别的逻辑  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ ipcMain.handle / webContents.send
┌───────────────────────────────┴──────────────────────────────────────┐
│  src/main  系统 / 网络 / 磁盘 / 窗口 / 托盘 / 快捷键 / AI 调用        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 纯函数与类型
┌───────────────────────────────┴──────────────────────────────────────┐
│  src/shared  没有 IO、没有 Electron：类型、Prompt、解析、语言、存储映射│
└──────────────────────────────────────────────────────────────────────┘
```

**铁律**：`src/main` 才能碰系统 / 网络 / 磁盘；`src/shared` 只放纯函数与类型；`src/renderer` 不做任何 IO。

路径别名：`@shared/*` → `src/shared/*`，`@renderer/*` → `src/renderer/src/*`（`electron.vite.config.ts` 与 `vitest.config.ts` 各配一份）。

## 目录树

```
src/
├── main/                             # 主进程
│   ├── index.ts                      # 启动、单实例、协议注册、服务装配；SMOKE / VERIFY 两个特殊入口
│   ├── ipc/handlers.ts               # 所有 IPC handler（唯一入口）+ runTranslation（唯一翻译管线）
│   └── services/
│       ├── ai/
│       │   ├── types.ts              # AIProvider 接口：translate(request, {onDelta, signal})
│       │   ├── createProvider.ts     # 选哪个 Provider：mock / 缺 Key / OpenAI 兼容
│       │   ├── OpenAICompatibleProvider.ts  # POST /chat/completions + 流式
│       │   ├── sse.ts                # 增量 SSE 解析、delta/message/error 提取
│       │   ├── errors.ts             # HTTP 状态 → 错误码；Key 脱敏
│       │   └── MockProvider.ts       # 不联网的固定答案（UI 验证用）
│       ├── bridge/                   # 浏览器连接（本机 HTTP 服务）
│       │   ├── localBridgeServer.ts  # 只绑 127.0.0.1、校验 Host、限体积、CORS、JSON
│       │   ├── bridgeService.ts      # 口令 / 路由 / 幂等表 / 任务表 / 单并发
│       │   ├── learnRequest.ts       # 方向解析 + 两次 AI 调用 + 交给 LanguageStore
│       │   ├── doorbell.ts           # ctoe:// 门铃：只回答「是不是门铃」
│       │   └── *.test.ts
│       ├── config/configStore.ts     # config.json + 系统安全存储加密（DPAPI）
│       ├── language/
│       │   ├── languageStore.ts      # learned.json（v4/v5/v6 → v7 迁移、原子写、0600）
│       │   └── languageLibrary.ts    # 文件形状 <-> 内存结构的读取与校验
│       ├── recent/recentStore.ts     # recent.json（默认不写，最多 50 条）
│       ├── window/windowManager.ts   # 单窗口：球 ⇄ 面板、位置记忆、置顶、隐藏
│       ├── window/windowGeometry.ts  # 纯几何：展开方向、离屏拉回、多显示器（可单测）
│       ├── tray/trayService.ts       # 托盘菜单 + 内嵌图标（不依赖外部图片）
│       ├── shortcut/                 # 全局快捷键 + accelerator 归一化
│       ├── startup/loginItem.ts      # 开机自启（仅安装版生效）
│       ├── clipboard/clipboardService.ts
│       ├── export/                   # 导出 Word（零依赖：自己写 ZIP + OOXML）
│       │   ├── zip.ts                # 最小 ZIP 写入（deflate + CRC32 + 中央目录）
│       │   ├── docx.ts               # 文档块 → .docx（A4、样式、表头跨页重复）
│       │   ├── learningExport.ts     # 一语言对一文件，写进用户选的文件夹
│       │   └── filesController.ts    # 唯一碰 dialog / shell 的地方（选目录 / 打开 / 定位）
│       └── extension/extensionPackage.ts  # 扩展文件夹在哪；找不到就直说
├── preload/index.ts                  # contextBridge：window.api
├── shared/                           # 纯逻辑，主进程与 UI 都能用
│   ├── types/
│   │   ├── index.ts                  # 领域类型（SavedSentence / LearningItem / RecentTranslation / 错误码…）
│   │   ├── ipc.ts                    # IPC 通道名与载荷类型（唯一真源）
│   │   ├── bridge.ts                 # 扩展协议：端口、口令、错误码、方向解析、请求净化
│   │   └── api.ts                    # window.api 的形状
│   ├── prompts/
│   │   ├── translation.ts            # buildPrompt()：按 task 分流（唯一入口）
│   │   ├── languageContext.ts        # 由请求推出 native / learning，Prompt 里没有写死的语言名
│   │   ├── expression.ts             # 生成（Say it）
│   │   ├── analysis.ts               # Learn（讲解）
│   │   └── understanding.ts          # 读懂（意思 + 学习点）
│   ├── learning/
│   │   ├── parse.ts                  # 结构化答案解析：完整版 + 流式版
│   │   └── exportDocument.ts         # 学习记录 → 文档模型（分组、排序、分类索引；纯函数）
│   ├── language/
│   │   ├── registry.ts               # 六种语言（唯一真源）
│   │   ├── script.ts                 # 文字体系识别（汉字/拉丁/西里尔/阿拉伯）
│   │   ├── pair.ts                   # 语言对（关系）与方向的合法组合
│   │   ├── records.ts                # 记录 <-> 视图（Expressions / Vocabulary）
│   │   ├── sentenceId.ts             # 六位十六进制短号（唯一格式化处）
│   │   └── recentLearn.ts            # 「最近翻译」那一行该按哪对语言学
│   ├── config/defaults.ts            # 默认值：Base URL / Model / 尺寸 / 超时 / 温度
│   └── errors/messages.ts            # 错误码 → 用户看得懂的中文
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx                   # 按 window:mode 渲染球还是面板；页面切换（面板/设置/学习/最近/来自浏览器）
        ├── pages/                    # AssistantPage / SettingsPage / MyLanguagePage / RecentTranslationsPage / BridgeSentencePage
        ├── components/               # FloatingBall / PanelChrome / TextPanel / AnalysisPanel / ModeBar / SavedSentenceCard / SettingsForm / StartCard …
        ├── hooks/                    # useTranslation（唯一的请求编排）/ useSettings / useLanguageRecords / useBrowserBridge …
        ├── services/                 # assistantApi（window.api 的封装）/ speech（朗读引擎）
        ├── utils/                    # id、相对时间、窗口模式
        └── styles/global.css
```

仓库其他部分：

```
extension/                # ★ 网站翻译插件（本仓库的一部分，不是外部依赖）
├── manifest.json         # 浏览器清单；version 由 npm run sync:version 注入
├── src/                  # 内容脚本 / Service Worker / 划词浮层 / options / popup / 桥接客户端
├── tests/                # unit（node --test，112 个）+ e2e（playwright，可选）
├── tools/ build.mjs      # 扩展自己的构建（esbuild）
└── vendor/tesseract/     # 离线 OCR 词库（24MB，下载而来，不进 Git）

scripts/
├── build-extension.mjs   # 对齐版本 → 跑 extension/build.mjs → 校验产物与 OCR 组件
├── sync-version.mjs      # 根 package.json → extension/manifest.json（唯一版本来源）
├── require-extension.mjs # 打包前守门：扩展产物不全就让打包失败
├── clean.mjs             # 删掉 out / release / extension/dist / OCR 词库 / smoke 数据
├── smoke.mjs             # 开真应用跑完整流程（CTOE_SMOKE=1）
└── verify-api.mjs        # 用真实配置跑一次生成（CTOE_VERIFY_API=1）

build/
└── installer.nsh         # NSIS 钩子：把 ctoe:// 写进 HKCU
```

> 扩展的源码在 `extension/`，`electron-builder` 直接从那里取 `manifest + dist + vendor` 放进安装包的
> `resources/extension`——中间没有暂存目录，所以不存在"构建了新的、打进包里的是旧的"。

## 一次 Generate 的调用链

```
AssistantPage
  └─ useTranslation.translate(text, tone)
       │  方向在这里定：profile.native → profile.learning（调用方传不反）
       └─ window.api.startTranslation({ requestId, task:'express', text, tone, ... })
            │ IPC invoke  translate:start
            ▼
main: handlers.registerIpcHandlers → runTranslation()
       ├─ 校验：非空、≤ 8000 字符
       ├─ createProvider({ providerKind, settings })      ← 缺 Key 时走 MissingKeyProvider
       ├─ buildPrompt(request)                            ← shared/prompts
       └─ provider.translate(request, { onDelta, signal })
            └─ POST {baseUrl}/chat/completions  stream:true
                 ├─ 每个 delta → sink.delta → IPC translate:delta → 面板逐字追加
                 └─ 结束     → storeRecent() → IPC translate:done（清掉包裹的引号后定稿）
```

## 一次 Learn 的调用链

```
useTranslation.analyze()
  │ 固定 native → learning（不管当前哪个模式）
  │ sentence = 面板两个框 + 当时的方向（主进程不猜哪个框是什么）
  ▼
IPC translate:start (task:'analyze')
  ▼
runTranslation()
  ├─ result 为空 → missing-result（没有可讲解的句子）
  ├─ provider.translate → JSON 流
  │    └─ 边收边 parseLearningAnalysisPartial：每凑齐一个点就 delta 一次（不显示半截花括号）
  ├─ parseLearningAnalysis(完整答案) === null → malformed-response
  ├─ storeLearned(language, payload, analysis)     ← 写盘就发生在这里
  └─ done { analysis, learned: SavedSentence, learnFailure }
       └─ 面板显示回执 #000001；写失败时 learnFailure 带原因
```

## 一次「浏览器 → 学习」的调用链

```
扩展（内容脚本 → Service Worker）
  └─ POST http://127.0.0.1:4311x/v1/learn   Authorization: Bearer <口令>
       ▼
main: localBridgeServer     绑定 / Host 头 / 体积 / JSON / CORS
       ▼
     bridgeService.route()  口令比对 → markSeen → 协议版本 → 幂等表 → 建任务（立刻 202 + taskId）
       │ 异步
       ▼
     runBridgeLearn()
       ├─ 方向解析：mode → langHint → 文字体系 → 默认 understand
       ├─ ask(understand | express)     ← 第 1 次 AI 调用
       ├─ ask(analyze)                  ← 第 2 次 AI 调用（固定 native → learning）
       │    └─ storeLearned() 写盘
       └─ onLearned → windows.expand() + IPC ui:learn-sentence →「来自浏览器」页
       ▼
扩展轮询 GET /v1/task/:taskId → state=learned + label=#000001
```

## 想改什么，动哪里

| 想改 | 只动这里 |
| --- | --- |
| 换模型 / 换厂商 | `src/main/services/ai/*`（实现 `AIProvider` 即可） |
| 改 Prompt | `src/shared/prompts/`（`translation.ts` 分流，其余三份是各自任务的正文） |
| 加一门语言 | `src/shared/language/registry.ts` 加一条 + `script.ts` 补它的文字体系（缺了会编译失败） |
| 改朗读声音 | `src/renderer/src/services/speech/index.ts`（换 `SpeechEngine` 实现） |
| 改导出的内容 / 分类 | `src/shared/learning/exportDocument.ts`（数据怎么组织）；只改排版动 `src/main/services/export/docx.ts` |
| 改「谁往哪边走」 | `src/renderer/src/hooks/useTranslation.ts`（面板方向只在那算） |
| 改「最近翻译里 Learn 用哪对语言」 | `src/shared/language/recentLearn.ts` |
| 改悬浮球几何 | `src/main/services/window/windowGeometry.ts`（纯函数） |
| 改扩展协议 | **两边一起**：`src/shared/types/bridge.ts` ↔ `extension/src/core/bridge.mjs`（`extensionContract.test.ts` 会盯着） |
| 改扩展行为 | `extension/src/`（它就在本仓库里），改完 `npm run build:extension` |
| 改快捷键 | `src/main/services/shortcut/accelerator.ts` + 设置页 |
| 改窗口形态 | `windowManager.ts` + `windowGeometry.ts` + `FloatingBall.tsx` |

## 十条不变式（改代码前先读）

1. **方向 = 档案 + 模式**。任何调用方（包括扩展）都不能直接指定语言对或方向。
2. **Learn 永远按 native → learning 提问**，所以它不可能去讲解母语。
3. **`learned.json` 的模型是 v7**：改字段必须能读 v4/v5/v6，迁移前先备份、写入必须原子。
4. **编号属于语言对**，永不复用、永不回绕；所有展示都走 `formatSentenceId()`。
5. **IPC 通道名只在 `shared/types/ipc.ts` 定义**；注册的通道集合与 preload 实际调用的一组必须完全一致（有测试盯着）。
6. **渲染进程不联网**；任何外部请求都只能从主进程发。
7. **只有点 Learn 才写学习库**；生成结果默认不落盘。
8. **扩展只能送一句话**：不能存数据、不能调 AI、不能选语言对；`url` / `title` 用完即弃。
9. **桥接口令在路由之前校验**；`/v1/health` 是唯一免口令的路由。
10. **`ctoe://` 只是门铃**，不携带句子 / 口令 / 语言。

---
