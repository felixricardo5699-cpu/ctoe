# 发布一个版本

> 给维护者看的：改完代码怎么产出可下载的安装包，以及 GitHub 上的 Release 怎么发。

## 1. 定版本号

`package.json` 的 `version` 决定产物文件名和「关于」里显示的版本：

```
release/ctoe-setup-<version>-x64.exe      安装版
release/ctoe-portable-<version>-x64.exe   免安装版
```

一处改、两处跟上（`npm version <x.y.z>` 会同时改 `package.json` 和 `package-lock.json`；手改的话两处都要动）：

- `package.json` → `version`
- `package-lock.json` → 顶部的 `version` 与 `packages[""].version`

规则：修 bug → patch（`0.1.0 → 0.1.1`）；加功能 → minor（`0.1.1 → 0.2.0`）；破坏性变更 → major。

## 2. 打包

**前置：先退出正在运行的 ctoe（托盘 → 退出）。**
便携版进程会锁住 `release/ctoe-portable-*.exe`，electron-builder 会停在 `output file is locked for writing ... waiting for unlock`，看起来像「打包没有更新」。

```bash
npm run build:win
```

它依次做四件事：

```
sync:version + typecheck          版本对齐 + 两套 tsconfig 的 strict 检查
electron-vite build               → out/
scripts/build-extension.mjs       构建本仓库 extension/（src → dist）
electron-builder --win            NSIS 安装包 + portable → release/
```

产物：

| 路径 | 说明 |
| --- | --- |
| `release/ctoe-setup-<version>-x64.exe` | 安装包（发布用） |
| `release/ctoe-portable-<version>-x64.exe` | 免安装版（发布用） |
| `release/win-unpacked/` | 解包目录，**只用来自检**，不是发布物 |

> `release/` 在 `.gitignore` 里：安装包**不进 Git 仓库**，只作为 Release 的附件上传。
> 发完版之后 `npm run clean` 可以一次删掉 out / release / extension/dist / OCR 词库，不留旧版本。

## 3. 发布前自检（5 分钟）

1. 版本对上了：`release/win-unpacked/resources/extension/manifest.json` 的 `version` === `package.json` 的 `version`（`npm test` 里有一条契约测试专门盯这个）。
2. 扩展进包了：同一目录的 `dist/sw.mjs` 里能搜到 `ot-learn-selection`，`vendor/tesseract` 也在（图片翻译靠它）。
3. 干净环境跑一遍：双击 `ctoe-setup-*.exe` 装一次 → 启动后**只看到小球** → 设置里填 Key → `Generate` 出结果。
4. 可选：`npm run verify:api` 用当前配置真跑一次（会打印首字延迟与结果，不打印 Key）。
5. 可选：`npm test`（705 个测试）、`npm run test:extension`（112 个）与 `npm run smoke`（真实应用端到端）。

## 4. 在 GitHub 上发 Release

### 网页操作

1. 仓库 → 右侧 **Releases** → **Draft a new release**。
2. **Choose a tag** 里输入 `v0.1.1`（与 `package.json` 保持一致，带 `v` 前缀）→ **Create new tag on publish**；Target 选 `main`。
3. **Title** 填 `v0.1.1`；**Describe this release** 写这版改了什么（模板见第 5 节）。
4. 把 `release/` 里的**两个 exe** 拖进附件区（GitHub 单个附件上限 2GB，这里每个约 100MB，没问题）。
5. 点 **Publish release**。

发完之后，README 里的「从 Releases 下载」才有东西可点。

### 命令行（装了 [gh](https://cli.github.com/)）

```bash
gh release create v0.1.1 \
  "release/ctoe-setup-0.1.1-x64.exe" \
  "release/ctoe-portable-0.1.1-x64.exe" \
  --title "v0.1.1" \
  --notes-file docs/release-notes-v0.1.1.md
```

## 5. 发布说明模板

```markdown
## 下载

| 版本 | 文件 | 适合谁 |
| --- | --- | --- |
| 安装版 | `ctoe-setup-0.1.1-x64.exe` | 想要开机自启、以后能稳定用浏览器扩展唤起 |
| 免安装版 | `ctoe-portable-0.1.1-x64.exe` | 解压即用，不想装 |

> 没有代码签名证书，首次运行 Windows 会提示「已保护你的电脑」→ 更多信息 → 仍要运行。

## 这版改了什么

- 浏览器扩展：右键选中的文字也能直接「发送到 AI Language Coach（学习这句）」
- 方向判定：页面没有 `lang` 属性时，按句子本身的文字体系判断，不再把母语当外语
- 浏览器扩展已并入本仓库：桌面端和插件的版本号必然一致（`npm test` 里有契约测试）
- 设置 → 数据与隐私 →「打开数据文件夹」，一眼看到 `learned.json` 在哪
- My Learning →「导出为 Word」：按语言对生成 `.docx`，逐句 + 分类索引，可直接打印

## 第一次用

1. 启动 → 屏幕上只有一个小球，按 `Ctrl+Shift+Space` 展开
2. 设置 → AI 服务 → 填 API Key（DeepSeek 默认，只填 Key 就行）
3. 写一句话 → Generate

详见 [README](../README.md)。
```

## 6. 可选：GitHub Actions 自动构建

扩展已经在这个仓库里，CI 不再需要第二个源码树。唯一需要联网的是 OCR 词库（`npm run fetch:ocr`，约 24MB，来自公开 CDN），GitHub runner 上有网。

```yaml
name: build-windows
on:
  push:
    tags: ['v*']
permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npm run fetch:ocr        # 离线 OCR 词库，不进 Git
      - run: npm test                 # 含扩展契约测试（版本 / 端口 / 协议）
      - run: npm run build:win
        env:
          ELECTRON_BUILDER_CACHE: ${{ runner.temp }}/electron-builder

      - uses: softprops/action-gh-release@v2
        with:
          files: release/*.exe
```

注意：

- Windows runner 上打包约 5–10 分钟；`electron-builder` 第一次会下载 Electron 与 NSIS 资源，之后走缓存。
- 这里**不做代码签名**（没有证书），产物和本地打包完全一致。
- 想只出文件不自动发版，把最后一步换成 `actions/upload-artifact`。
