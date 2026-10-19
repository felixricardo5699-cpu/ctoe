# API 调用结构

> 本文是 [README](../README.md) 的延伸。三条对外边界（IPC / AI 服务商 / 本机桥接）各自的请求与响应形状，以及落盘格式。

这个项目有三条对外边界，它们都收敛到**同一条内部管线** `runTranslation()`：

```
        ┌──────────────────────┐
        │   AI 服务商（HTTPS）  │  ← ② 主进程 → 外部
        └──────────▲───────────┘
                   │ POST /chat/completions (SSE)
┌──────────────────┴───────────────────────────────┐
│                    src/main                      │
│   runTranslation()  ← 唯一翻译管线 / 唯一写盘点    │
└───▲───────────────────────────────▲──────────────┘
    │ ① IPC（invoke + 事件）          │ ③ 本机 HTTP（127.0.0.1）
┌───┴──────────────┐        ┌───────┴──────────────────┐
│  渲染进程（UI）   │        │ 浏览器扩展（extension/）│
└──────────────────┘        └──────────────────────────┘
```

## ① 渲染进程 ↔ 主进程（IPC）

全部通道定义在 `src/shared/types/ipc.ts`，preload 把它们包成 `window.api`。

| 通道 | 方向 | 载荷 → 返回 |
| --- | --- | --- |
| `settings:get` / `settings:set` | UI → main | `()` → `PublicSettings` / `(SettingsPatch)` → `PublicSettings` |
| `translate:start` | UI → main | `TranslateStartPayload` → `void`（结果走事件） |
| `translate:cancel` | UI → main | `requestId` → `void`（触发 AbortSignal） |
| `translate:delta` | main → UI | `{ requestId, text, analysis? }` |
| `translate:done` | main → UI | `{ requestId, text, analysis?, learned?, learnFailure? }` |
| `translate:failed` | main → UI | `{ requestId, failure: { code, detail } }` |
| `clipboard:read` / `clipboard:write` | UI → main | `()` → `string` / `(text)` → `boolean` |
| `window:expand/collapse/toggle/hide/quit` | UI → main | `()` → `void` |
| `window:get-mode` / `window:mode` | UI → main / main → UI | `()` → `{ mode, anchor }` / 推送 |
| `window:drag-start` / `drag-end` | UI → main | `()` → `void` |
| `shortcut:get` / `shortcut:set` / `shortcut:status` | UI ⇄ main | `ShortcutStatus` |
| `language:list/save/remove/clear` | UI → main | `()` → `SavedSentence[]` 等 |
| `recent:list` / `recent:clear` | UI → main | `() → RecentTranslation[]` |
| `bridge:get-status` / `bridge:reset-token` | UI → main | `() → BridgeStatus` |
| `bridge:status` | main → UI | 推送 `BridgeStatus` |
| `ui:open-settings` | main → UI | 托盘 / 二次启动要求打开设置 |
| `ui:learn-sentence` | main → UI | 推送 `BridgeLearnEvent`（浏览器学到的句子） |
| `extension:open-folder` | UI → main | `()` → `{ ok, folder, message }` |
| `language:export` | UI → main | `()` → `LearningExportResult`（弹文件夹选择框，写 `.docx`，返回文件夹与文件列表） |
| `data:open-folder` | UI → main | `()` → `DataFolderResult`（打开 `config.json` / `learned.json` 所在目录） |
| `app:info` | UI → main | `() → { version, platform, configPath }` |

`translate:*` 是一条**流**：`start` 立刻返回，结果通过 delta / done / failed 三个事件回来；渲染进程用 `requestId` 过滤，所以取消或重发之后，迟到的回复不会覆盖新的结果。

## ② 主进程 → AI 服务商（唯一的外部请求）

### 请求

```
POST {baseUrl}/chat/completions
content-type: application/json
accept: text/event-stream
authorization: Bearer {apiKey}
```

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "<该任务的规则，见下表>" },
    { "role": "user",   "content": "<该任务的输入>" }
  ],
  "temperature": 0.7,
  "stream": true
}
```

- `baseUrl` 结尾的 `/` 会被去掉；已经以 `/chat/completions` 结尾时不再重复拼。
- **没有** `max_tokens`、`top_p`、`n`、`user`、`tools`；不读 `usage`（不统计 token）。
- 只有两条消息：一个 system（规则）+ 一个 user（内容），没有 few-shot 示例。
- 一次请求**只发一次**，没有自动重试（重试由用户再点一次决定）。

### 三种任务

| task | 触发 | system | user | temperature |
| --- | --- | --- | --- | --- |
| `express` | `Generate` / 重新生成 | 「把母语想法写成自然的外语」+ 语气规则 | `What I want to say (中文):\n<原文>` | **0.7** |
| `analyze` | `Learn` | 「语言教练：挑出这句话里值得学的点」+ JSON 形状 | `What I meant (中文):\n<意思>\n\nNatural English:\n<结果>\n\nTone: casual` | **0.3** |
| `understand` | `Explain` | 「语言教练：这段话什么意思 + 值得学的点」+ JSON 形状 | `English I read:\n<原文>` | **0.3** |

（示例是 `中文 → English`；实际的语言名由 `languageContext()` 从请求推出，Prompt 里没有写死的语言。）

`context` 字段为未来预设（X / Reddit / Email / Discord）留的，v1 恒为空。

### 结构化答案的形状（`analyze` / `understand`）

`analyze`：

```json
{
  "items": [
    {
      "kind": "expression",
      "expression": "come up",
      "meaning": "突然发生 / 有事",
      "why": "口语里替代 happen 的高频短语",
      "example": "Something came up, so I had to leave.",
      "exampleTranslation": "临时有点事，所以我得走了。",
      "importance": "high"
    }
  ]
}
```

`kind`：`expression`（可复用的搭配）/ `pattern`（句式框架）/ `vocabulary`（单词）/ `grammar`（结构）。
`importance`：`high` / `medium` / `low`（只影响排序，不会丢点）。

`understand`：

```json
{ "meaning": "整段话的自然母语意思", "items": [ /* 同上 */ ] }
```

### 流式怎么读

```
data: {"choices":[{"delta":{"content":"I"}}]}
data: {"choices":[{"delta":{"content":" think"}}]}
data: [DONE]
```

- 用增量 `SseParser` 切 `\n\n`，能处理任意 chunk 边界、`\r\n`、以及以 `:` 开头的注释行。
- 文本来源：`choices[0].delta.content`（标准）；兼容 `choices[0].text`（老式补全）。
- 结束标记：`data: [DONE]`；收到后立刻 `reader.cancel()`，不白等。
- **少数网关无视 `stream:true`**：`content-type` 是 `application/json` 时按非流式读 `choices[0].message.content`，整段一次性交给 `onDelta`。
- 流内错误：`{"error":{"message":"..."}}` → `server-error`。
- 三种「空」分得很清楚：没有任何 SSE 负载 → `malformed-response`；有负载但没文本 → `empty-response`；请求根本没发出去（DNS / 连不上）→ `network`。
- 流读到一半连接断了（`reader.read()` 抛错）会作为未归类错误上抛（`unknown`）；此时 `done` 事件不会发出，所以屏幕上不会留下半截结果。

**Learn / Understand 的流式不是把原文吐出来**：主进程边收边解析 JSON，只把**已经闭合**的学习点（以及 Understand 里「到目前为止的含义快照」）推给 UI，所以界面上不会出现半截花括号。

### 超时、取消、错误码

- 超时：**60 秒**（`REQUEST_TIMEOUT_MS`），到点 abort 并报 `timeout`。
- 取消：用户取消 → 外部 `AbortSignal` → 报 `cancelled`（与超时区分开）。
- 输入上限：8000 字符（`MAX_INPUT_CHARS`），超了在发请求前就拒绝。
- HTTP → 错误码：

| 状态 | 错误码 |
| --- | --- |
| 401 / 403 | `unauthorized` |
| 404 | `model-not-found` |
| 400 且响应里有 `model` | `model-not-found` |
| 400 其它 | `malformed-response` |
| 429 | `rate-limited` |
| ≥ 500 | `server-error` |
| 其它 | `unknown` |

- 错误详情一律先 `redactKey()`（把 API Key 换成 `[redacted]`）再截断到 300 字符；渲染进程只拿错误码，`detail` 只进 console。

## ③ 浏览器扩展 ↔ 主进程（本机桥接 HTTP）

协议的唯一真源是 `src/shared/types/bridge.ts`（不 import Electron，所以以后手机端也能复用）。

| 项 | 值 |
| --- | --- |
| 地址 | 只绑 `127.0.0.1`，端口 `43110–43119` 取第一个空闲的 |
| 协议版本 | `1`，用请求头 `x-ctoe-protocol` 声明 |
| 鉴权 | `Authorization: Bearer <口令>`；口令 32 字节随机（64 位十六进制） |
| 免鉴权路由 | 只有 `GET /v1/health` |
| 请求体上限 | 256 KB |
| 幂等窗口 | 60 秒内同一个 `requestId` 返回同一个任务 |
| 任务保留 | 10 分钟 TTL，最多 50 条 |
| 并发 | 同时只跑一个；新请求把旧的置为 `superseded` |
| 句子长度 | ≤ 8000 字符（与输入框一致） |

### 四个路由

**`GET /v1/health`**（无需口令）

```json
{ "ok": true, "protocol": 1, "app": "ctoe", "version": "0.1.0", "busy": false }
```

**`POST /v1/pair`**（校验口令，扩展粘贴口令后调一次）

```
Authorization: Bearer <口令>
{ "token": "<口令>" }
```
```json
{ "ok": true, "protocol": 1, "version": "0.1.0" }
```

**`POST /v1/learn`**（递交一句话，立刻返回任务号）

```
Authorization: Bearer <口令>
{
  "requestId": "3f2c…",          // 必填，[A-Za-z0-9._:-]{1,64}，重试用同一个
  "text": "I was going to join you.",  // 必填，空白折叠后 ≤ 8000
  "mode": "understand",          // 可选：understand | express
  "langHint": "en",              // 可选：页面 lang 的主子标签
  "url": "https://…",            // 可选：只用于展示来源，不落盘
  "title": "…"                   // 可选：同上
}
```
```http
202 Accepted
{ "ok": true, "taskId": "t1" }
```

**`GET /v1/task/:taskId`**（轮询结果）

```json
{
  "ok": true,
  "state": "learned",                 // pending | learned | failed
  "sentenceId": 1,                    // 落库后的编号（对语言对内）
  "pair": { "nativeLanguage": "zh", "learningLanguage": "en" },
  "failure": null,                    // failed 时是错误码
  "label": "#000001"                  // 已经由桌面端格式化好
}
```

### 失败时的响应

```json
{ "ok": false, "error": "unauthorized" }
```

| 错误码 | 含义 | HTTP |
| --- | --- | --- |
| `unauthorized` | 没口令或口令不对 | 401 |
| `bridge-off` | 用户关掉了浏览器连接 | 401 |
| `protocol-too-new` | 扩展比桌面端新 | 400 |
| `empty-text` | 没有文本 | 400 |
| `text-too-long` | 超过 8000 字符 | 400 |
| `bad-json` | 请求体不是协议描述的 JSON | 400 |
| `not-found` | 没有这个任务或已过期 | 400 |
| `superseded` | 被更新的请求顶掉 | 400 |
| `storage-failed` | 讲解拿到了但写盘失败 | 400 |
| `language-pair-id-exhausted` | 这对语言编号用尽 | 400 |
| `translation-failed` | AI 调用失败 | 400 |
| `internal` | 未预期错误 | 500 |

### 方向是怎么定的（扩展永远不选语言对）

```
1. 请求里明确写了 mode          → 用它的
2. langHint 能对上档案的一侧     → 提示的就是正在学 → understand；就是母语 → express
3. 都没有 → 看这句话的文字体系：
     只落在档案一侧（如中文 vs 英文）→ 就用那一侧
     两边同体系（en/fr/es 都是拉丁）或第三种文字 → 判不出来，保持默认
4. 默认 → understand（"在网页上指一句话，通常是想读懂它"）
```

第 3 步是 `src/shared/language/script.ts` 的职责，也是「页面没有 `lang` 属性时不会把母语当成外语」的原因。

### 传输层细节

- **Host 头必须是回环**（`127.0.0.1` / `localhost` / `[::1]`），否则 403——挡 DNS rebinding。
- **CORS**：回显 `Origin`（扩展的 `chrome-extension://` 在编译期不可知），`Vary: Origin`，预检回显请求的头，并允许私有网络访问。
- **OPTIONS** 由传输层直接答 204，不进入路由。
- 请求体超限 / 不是 JSON / 没有 body，都在路由之前被拒。
- 路由抛异常 → 500 `internal`，不会把连接带崩。

### `ctoe://` 门铃

桌面端没在跑的时候 HTTP 叫不醒它，只有自定义协议能：

- 扩展用真 `<a href="ctoe://wake">` + `click()` 点一次（必须在用户手势里）；
- 桌面端 `doorbellRequested(argv)` 只回答「这是不是门铃」这一个布尔值——**URL 里不携带任何句子 / 口令 / 语言**，所以任何人伪造一条链接也只能把窗口叫到前面；
- Windows 上「谁来应答 `ctoe://`」写两处：安装程序 `build/installer.nsh`（HKCU）和启动时的 `setAsDefaultProtocolClient()`（便携版 / 开发态靠它）。electron-builder 的 `protocols` 只管 macOS / Linux / Appx，**不管 Windows**。

## 落盘格式

三份 JSON 都在同一个目录（默认 `%APPDATA%\ctoe`，可用 `CTOE_DATA_DIR` 整体搬走），权限 0600，写入是「临时文件 + rename」的原子写。

**`config.json`（v2）**

```json
{
  "version": 2,
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "tone": "natural",
  "providerKind": "openai-compatible",
  "nativeLanguage": "zh",
  "learningLanguage": "en",
  "floatingBall": true,
  "globalShortcut": "CommandOrControl+Shift+Space",
  "launchAtLogin": false,
  "recentPolicy": "on",
  "browserBridgePolicy": "on",
  "apiKey":     { "value": "<加密后的 base64>", "encrypted": true },
  "bridgeToken":{ "value": "<加密后的 base64>", "encrypted": true },
  "panel": { "width": 480, "height": 520 },
  "ball":  { "x": 1200, "y": 700 },
  "bridgeLastRequestAt": "2026-10-18T13:42:22.439Z"
}
```

**`learned.json`（v7）**——按「母语 → 正在学」分桶，每桶自己的 `nextId`：

```json
{
  "version": 7,
  "languages": {
    "zh": {
      "en": {
        "nextId": 2,
        "records": [
          {
            "id": 1,
            "nativeLanguage": "zh",
            "learningLanguage": "en",
            "sourceLanguage": "zh",
            "targetLanguage": "en",
            "originalText": "我本来打算加入你们，但临时有点事。",
            "translatedText": "I was going to join you, but something came up.",
            "tone": "natural",
            "createdAt": "2026-10-18T13:47:28.931Z",
            "savedAt": "2026-10-18T13:47:28.931Z",
            "studyCount": 1,
            "lastReviewedAt": "2026-10-18T13:47:28.931Z",
            "masteryScore": 0,
            "knowledgePoints": [
              {
                "id": "79167cb2-…",
                "kind": "expression",
                "expression": "come up",
                "meaning": "临时有事 / 突然发生",
                "why": "口语里最常用的替代说法",
                "example": "Something came up.",
                "exampleTranslation": "临时有点事。",
                "importance": "high",
                "audioLanguage": "en"
              }
            ]
          }
        ]
      }
    }
  }
}
```

四个语言字段不可互换：`nativeLanguage` + `learningLanguage` 是**这条属于哪一对关系**（也是编号与分类的依据）；`sourceLanguage` → `targetLanguage` 是**这一次实际往哪边走**。所以同一对语言里可以既有 `Say it` 又有 `Understand` 的记录，共用一串编号。改设置只影响之后新建的记录，旧记录一个字段都不动。

**`recent.json`（v1）**

```json
{
  "version": 1,
  "entries": [
    {
      "id": "…",
      "sourceLanguage": "zh",
      "targetLanguage": "en",
      "learningLanguage": "en",
      "tone": "natural",
      "sourceText": "只能在小范围…",
      "targetText": "It can only add a little precipitation…",
      "createdAt": "2026-10-18T13:48:17.785Z"
    }
  ]
}
```

---

## 错误码 → 用户看到的话

| 错误码 | 界面文案 |
| --- | --- |
| `missing-api-key` | 还没有配置 API Key，请到设置里填写。 |
| `unauthorized` | API Key 无效，请检查设置。 |
| `model-not-found` | 模型不存在，请在设置里检查模型名称。 |
| `rate-limited` | 请求过于频繁或额度不足，请稍后再试。 |
| `timeout` | AI 服务响应超时，请重试。 |
| `network` | 连接 AI 服务失败，请检查网络后重试。 |
| `server-error` | AI 服务暂时不可用，请稍后再试。 |
| `empty-response` | AI 没有返回内容，请重试。 |
| `malformed-response` | AI 返回的内容无法识别，请重试或更换模型。 |
| `input-too-long` | 输入内容太长了，请分段生成。 |
| `missing-input` | 请先输入你想表达的意思。 |
| `missing-result` | 还没有生成结果，请先点 Generate。 |
| `missing-sentence` | 没有找到要记录的句子，请先生成结果再点 Learn。 |
| `storage-failed` | 学习记录没能写入，请再点一次 Learn 重试。 |
| `language-pair-id-exhausted` | 这个语言对的编号已经用完，无法再保存新的句子。 |
| `cancelled` | 已取消本次生成。（面板回到可重试状态） |
| `unknown` | 生成失败，请重试。 |
