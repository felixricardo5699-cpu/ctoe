# 开发与打包

> 本文是 [README](../README.md) 的延伸：环境、测试、打包，以及浏览器扩展的补丁流程。
> 只想用这个软件的话，看 [README](../README.md) 就够了。

## 环境与依赖

- Node.js **>= 22.12**（Electron 44 的要求；用 Node 24.20 / npm 11.19 验证过）
- Windows 10/11（主目标平台；macOS / Linux 理论可用，未实测）
- 可选：Anaconda —— **只**作为项目独立的开发工具环境，应用运行时不用 Python

```bash
npm install
npm run dev        # Vite dev server + Electron（改主进程会自动重启）
```

第一次运行会下载 Electron 二进制（约 100MB，只发生一次，需要联网）。下载失败时先设镜像：

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install
```

### 受限环境（沙箱 / CI / 容器）

Chromium 的沙箱或 GPU 进程起不来时，表现为窗口一闪就退出：

```bash
npm run smoke -- --no-sandbox
npx electron-vite dev --noSandbox
```

## 命令

```bash
npm run typecheck        # TypeScript strict（node + web 两套 tsconfig）
npm test                 # 705 个测试 / 47 个文件
npx vitest run src/main  # 只跑主进程 / Provider / 窗口 / 快捷键
npm run smoke            # 开真应用跑完整流程（需要先 npm run build）
npm run verify:api       # 用真实配置跑一次生成
```

## 覆盖范围（按层）

| 层 | 覆盖 |
| --- | --- |
| Provider | 流式、非流式 JSON 兜底、401/403/404/429/5xx、400 里含 model、超时、取消、空响应、非 SSE 响应、流内错误、乱码事件、Key 脱敏 |
| Prompt / 解析 | 六种语言两两组合都带正确的语言名、三种 task 分流、URL/emoji/换行不被破坏、Learn 与 Understand 的完整与流式解析（未闭合不猜、重复去重、未知 kind 回退） |
| 窗口 / 几何 | 展开方向、点击 vs 拖拽阈值、离屏拉回、显示器变化、球 ⇄ 面板、托盘隐藏 |
| 存储 | config 白名单与加密、learned.json v4/v5/v6 → v7 迁移、编号不复用、坏文件不崩、原子写 |
| 桥接 | 未授权在路由之前挡掉、Host 非回环拒绝、幂等、superseded、端口占用换下一个、`off` 时不监听、落盘与面板 Learn 完全一致、方向解析（含文字体系兜底） |
| UI | 两模式草稿、流式、取消、Learn 回执、My Learning 增删查、朗读、错误提示、IPC 通道集合与 preload 一一对应 |
| 排版 | 真渲染进程里量像素：Learn 拉到 200px 时窗口按钮与工具栏仍可见可点、两个输入框各留 40px 以上 |

## `npm run smoke` 会做什么

用独立数据目录（`.cache/smoke-data`，每次清掉 `learned.json` / `recent.json`）开真应用，走一遍：

悬浮球 → 展开 → 聚焦 → 粘贴 → Generate → Learn（每个点都带例句翻译与朗读按钮）→ 看到回执 → My Learning 里查到 → 切 Understand → 粘贴英文 → Explain → 从读到的那句再 Learn → 两模式来回切（草稿还在）→ 换语言 → 在「最近翻译」里对着**换语言之前**写下的那行点 Learn（要按那行自己的语言对入库）→ 打开浏览器连接开关，用**真实 HTTP 请求**（不点界面）往回环端口发一句话 → 检查按当时档案的语言对入库、任务回到 `learned`、短号与文件里那条一致、窗口切到「来自浏览器」→ Learn 面板极限排版 → 收起回球。

## 装好之后的手工验收（浏览器那半）

自动测试不启动真浏览器，所以这一段要手动点一次：

1. `chrome://extensions` → 重新加载扩展 → 版本应与软件版本一致（当前 `0.1.1`）。
2. 桌面端设置 → 浏览器连接 → 复制口令 → 扩展弹窗粘贴 → 连接 → 应显示「✓ 已连接（端口 431xx，协议 v1）」。
3. 任意英文网页选中一句 → 右键 →「发送到 AI Language Coach（学习这句）」→ 页面右下角出回执、桌面端跳到「来自浏览器」。
4. 按住 `Ctrl+Shift` 划词 → 浮层底部「学习这句」→ 按钮变「✓ 已学习 #0000xx」。

---

## 打包与发布

### `npm run build:win` 的顺序

```
sync:version → typecheck → electron-vite build（→ out/）
             → 扩展自己的 build.mjs（extension/src → extension/dist）
             → electron-builder --win（extraResources 直接取 extension/ → NSIS + portable）
```

`electron-builder.yml` 的关键几项：

| 配置 | 作用 |
| --- | --- |
| `extraResources: extension/ → resources/extension`（filter：manifest + dist + vendor） | 扩展随安装包进 `resources/extension`，源码与测试不进包 |
| `beforePack: scripts/require-extension.mjs` | 守门：`extension/` 里没有 manifest / dist/sw.mjs / dist/content.js 就让打包失败（曾经发出过装完才提示「没带扩展」的包） |
| `electronLanguages` | 只带 6 种语言的 Chromium 语言包，砍掉约 48MB |
| `differentialPackage: false` | 不做自动更新，改用完整 LZMA2 压缩（实测省约 10MB） |
| `electronDist: node_modules/electron/dist` | 用 npm 已装好的 Electron，打包更快、断网也能打 |

打包机写不了默认缓存目录时：

```powershell
$env:ELECTRON_BUILDER_CACHE = "$PWD\.cache\electron-builder"
npm run build:win
```

> 打包前先托盘 → 退出。旧实例会锁住 `ctoe-portable-*.exe`，electron-builder 会停在 `output file is locked for writing`。

### 体积（实测，不是估算）

| 构建 | 安装包 | 解包后 | 说明 |
| --- | --- | --- | --- |
| A：完整运行时 + 插件（含 OCR） | **96.5 MB** | 349.9 MB | 改动前的基线 |
| B：A − `dxcompiler.dll` / `vk_swiftshader*` / `ffmpeg.dll` | **89.2 MB** | 317.1 MB | 现在默认走这条 |

- 省下的 7.3 MB 来自三个本程序从不加载的运行时组件：渲染层是纯 DOM，不用 WebGPU、不用软件 Vulkan、没有音视频。
- 打包后会自动删除；想打一个完整运行时的包：`$env:CTOE_KEEP_RUNTIME='1'; npm run build:win`。
- 剩下的大头是 `ctoe.exe`（234.8 MB）、`LICENSES.chromium.html`（19.5 MB，法律要求随包）、`resources.pak` / `icudtl.dat` 和插件的 OCR 词库（24.6 MB，由 `npm run fetch:ocr` 下载）。再往下压只能换框架（Tauri / WebView2，20–30 MB 量级），那是重写，不在清理范围。

### 扩展就在这个仓库里

扩展不再是"隔壁仓库 + 补丁"，而是 `extension/` 目录本身：

```
extension/
├── manifest.json       ← 浏览器读的清单（version 由 npm run sync:version 从根 package.json 注入）
├── src/                ← 源码：内容脚本 / Service Worker / 划词浮层 / 桥接客户端
├── tests/unit/         ← 112 个单测（node --test，无依赖）
├── tests/e2e/          ← 真 Chromium 的 e2e（需要 playwright，见下）
├── tools/ build.mjs    ← 它自己的构建（esbuild，用仓库根部的依赖）
└── vendor/tesseract/   ← 离线 OCR 词库，24MB，gitignore；npm run fetch:ocr 下载
```

- `npm run build:extension` = 对齐版本 + 跑 `extension/build.mjs` + 校验产物（manifest / dist/sw.mjs / dist/content.js）+ 检查 OCR 组件。
- 产物留在 `extension/dist`，`electron-builder` 直接从 `extension/` 取，**没有中转目录**，所以不存在"构建了但打进包里的是旧副本"。
- `npm run fetch:ocr` 下载 tesseract（eng / chi_sim / chi_tra），只做一次；没有它也能构建，但要显式设置 `CTOE_ALLOW_MISSING_OCR=1`，否则 `build:extension` 会停下来提示。
- 扩展自己的 e2e 需要它的 devDependency：`npm --prefix extension install`，然后 `npm --prefix extension run e2e`（会开一个 Chromium 窗口）。
- 改了扩展源码想立刻试：`npm run build:extension` → 浏览器 `chrome://extensions` 点「重新加载」。

### 版本必须一致

`package.json` 的 `version` 是**唯一**手改的版本号；`npm run build:extension`（以及 `build:win`）会先跑 `scripts/sync-version.mjs`，把它写进 `extension/manifest.json` 和 `extension/package.json`。

`src/main/services/bridge/extensionContract.test.ts` 会断言两件事：

1. 扩展 `manifest.json` 的版本 === 根 `package.json` 的版本；
2. 扩展的桥接常量（host / 端口范围 / 协议版本 / 上限 / 模式）与 `src/shared/types/bridge.ts` 完全一致。

任意一条不成立，`npm test` 直接红——不会出现"软件是新的、插件是旧的"的安装包。

### `ctoe://` 的两条注册路径

- 安装程序：`build/installer.nsh` 的 `customInstall` 写 `HKCU\Software\Classes\ctoe`（`customUnInstall` 删掉）；`perMachine: false`，不需要管理员权限。
- 运行期：`registerDoorbellScheme()` 用 `app.setAsDefaultProtocolClient()` 再写一次（便携版与开发态只能靠这条）。写失败静默——门铃只是顺手，桥接不依赖它。

---

## 脚本与环境变量

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite dev server + Electron（改主进程自动重启） |
| `npm run build` | typecheck + 生产构建到 `out/` |
| `npm run build:extension` | 对齐版本 + 构建扩展（`extension/src → extension/dist`） |
| `npm run fetch:ocr` | 下载离线 OCR 词库到 `extension/vendor/tesseract`（一次） |
| `npm run sync:version` | 把根 `package.json` 的版本写进扩展 manifest |
| `npm run test:extension` | 扩展的 112 个单测（不需要额外依赖） |
| `npm run build:win` | 打 Windows 安装包到 `release/` |
| `npm run typecheck` | 两套 tsconfig 的 strict 检查 |
| `npm test` / `test:watch` | 全量 / 监听 |
| `npm run smoke` | 真应用端到端（`CTOE_SMOKE=1`） |
| `npm run verify:api` | 用真实配置跑一次生成（`CTOE_VERIFY_API=1`） |
| `npm run clean` | 删掉 out / release / extension/dist / OCR 词库 / smoke 数据 |

环境变量：`CTOE_DATA_DIR`（数据目录）、`CTOE_DISABLE_GPU=1`（禁用硬件加速）、`CTOE_SMOKE=1`、`CTOE_VERIFY_API=1` / `CTOE_VERIFY_API_KEY` / `CTOE_VERIFY_BASE_URL` / `CTOE_VERIFY_MODEL` / `CTOE_VERIFY_TEXT`。
