// ============ 打包脚本：把扩展打成「别人拿到解压就能用」的 zip ============
// 用法：
//   node tools/package.mjs            先构建（build.mjs）再打包
//   node tools/package.mjs --no-build 跳过构建，用现有 dist/
//   node tools/package.mjs --verify   打包后再跑一遍 e2e，验证「解压出来的目录」真的能加载并翻译
//
// 产物（release/ 下）：
//   release/omni-translate/            解压后的样子，也正是 Chrome「加载已解压的扩展程序」要选的目录
//   release/OmniTranslate-<版本>.zip   发给别人的文件，内部顶层目录是 omni-translate/
//
// 打包内容：manifest.json + dist/（构建产物）+ vendor/tesseract/（离线 OCR）+ 文档 + 使用说明.txt
// 不打包：src/ tests/ tools/ node_modules/（收包的人不需要 Node，也不需要源码）
//
// 说明：zip 是手写的（只用 Node 自带 zlib，不引第三方依赖），写完会回读校验每个条目的 CRC 与内容哈希；
//       打包前还会按 manifest.json 逐项核对文件是否齐全，避免「发出去才发现少文件、缺 OCR 语言包」。
import { spawnSync } from 'node:child_process';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');
const pkgName = 'omni-translate';                 // zip 内的顶层目录名（解压后就叫这个）
const stagingDir = join(releaseDir, pkgName);     // 同时留一份解压好的目录，方便本地先试装

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const verify = argv.includes('--verify');

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipPath = join(releaseDir, `OmniTranslate-v${version}.zip`);

// ---------- 1. 构建 ----------
if (!noBuild) {
  console.log('[pack] 构建 dist/ …');
  const r = spawnSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[pack] 构建失败，已中止'); process.exit(1); }
}

// ---------- 2. 收集要打包的文件 ----------
const INCLUDES = [
  'manifest.json',
  'dist',
  'vendor/tesseract',
  'README.md',
  'DESIGN.md',
  'ARCHITECTURE.md',
  'LICENSE'
];

function walk(abs, out = []) {
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), out);
  } else {
    out.push(abs);
  }
  return out;
}

const files = [];
for (const inc of INCLUDES) {
  const abs = join(root, inc);
  if (!existsSync(abs)) {
    console.warn(`[pack] 缺少 ${inc}，跳过`);
    continue;
  }
  for (const f of walk(abs)) files.push(f);
}

// ---------- 3. 校验：manifest 引用到的文件必须在包里 ----------
function refList() {
  const m = manifest;
  const out = [];
  const push = (p) => { if (typeof p === 'string' && p) out.push(p); };
  Object.values(m.icons || {}).forEach(push);
  push(m.background && m.background.service_worker);
  for (const cs of m.content_scripts || []) { (cs.js || []).forEach(push); (cs.css || []).forEach(push); }
  push(m.action && m.action.default_popup);
  push(m.options_page);
  for (const p of Object.values((m.action && m.action.default_icon) || {})) push(p);
  return out;
}

const packed = new Set(files.map((f) => relative(root, f).split('\\').join('/')));
const problems = [];
for (const ref of refList()) {
  if (!packed.has(ref)) problems.push(`manifest 引用的文件不在包里: ${ref}`);
}
// 离线 OCR：offline 文档运行时会探测这几个文件（见 src/offscreen/main.mjs 的 probe 列表）
for (const f of [
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core.wasm.js',
  'vendor/tesseract/core/tesseract-core-simd.wasm.js',
  'vendor/tesseract/langs/eng.traineddata'
]) {
  if (!packed.has(f)) problems.push(`离线 OCR 组件缺失: ${f}（先跑 npm run fetch-ocr）`);
}
if (problems.length) {
  console.error('[pack] 校验失败：');
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}

// ---------- 4. 使用说明.txt（给收包的人看；UTF-8 BOM + CRLF，Windows 记事本直接打开不乱码） ----------
const readmeTxt = [
  `OmniTranslate 万译 · 全能网页实时翻译  v${version}`,
  '================================================',
  '',
  '【怎么装】Chrome / Edge，3 步，约 1 分钟',
  '1. 先解压：右键这个压缩包 →「全部解压缩」。解压后找到里面有 manifest.json 的那个文件夹',
  `   （通常是 omni-translate，若解压出了多层，就选最里面那层）。`,
  '2. 打开浏览器，地址栏输入 chrome://extensions 回车（Edge 是 edge://extensions），',
  '   打开右上角的「开发者模式」。',
  '3. 点左上角「加载已解压的扩展程序」，选中第 1 步那个文件夹。',
  '   —— 必须是「能直接看到 manifest.json」的那一层，不要选它的上一级，也不要进去选 dist。',
  '',
  '装好后把图标固定到工具栏（地址栏右边拼图图标 → 点图钉），用起来更方便。',
  '',
  '【怎么用】',
  '· 一键整页翻译：点工具栏图标 →「一键翻译本页」；或按 Alt+T；或点网页右下角的悬浮球「译」。',
  '  再按一次 Alt+T 即还原成原文。',
  '· 划词翻译：选中任意英文，旁边立刻弹出中文（Alt+Shift+S 开关这个功能）。',
  '· 图片翻译：在悬浮球面板里打开「图片翻译」，然后点网页上的图片，即可识别并翻译图中的英文。',
  '· 仅译文 / 双语对照：在弹窗里随时切换，不刷新页面。',
  '· 更多设置：弹窗里的「设置」→ 目标语言、翻译引擎、只翻译正文区域、OCR 语言、调试信息等。',
  '  · 「句级重建」：被行内标签切开的同一句话会合并成整句翻译，读起来更通顺（默认开）。',
  '  · 「页头含主标题（h1/h2）且不含导航时按正文翻译」：博客/文档站的文章标题常在页头（默认开）。',
  '',
  '【第一次用要注意】',
  '· 文字翻译需要联网（走 Google / Microsoft Edge 的免费翻译接口，不需要注册、不花钱）。',
  '  图片 OCR 完全离线，不联网也能用。',
  '· 某网站翻译不出来时：先在弹窗点「测试引擎」看是不是网络不通，',
  '  再到设置页把引擎顺序换成 Edge 试试；也可能是该页文字在图片里，改用图片翻译。',
  '· 需要 Chrome 116 及以上（2023 年 8 月之后的版本），Edge 同版本号要求。',
  '· 隐私：本扩展只改写网页里的文字节点，不上传、不收集任何数据；设置只保存在你自己电脑上。',
  '',
  '【这个包里有什么】',
  '  manifest.json       扩展清单，Chrome 靠它识别本扩展',
  '  dist/               程序本体（构建产物：内容脚本、后台、弹窗、设置页、图标）',
  '  vendor/tesseract/   离线图片 OCR 组件（含英文 / 简体中文 / 繁体中文语言包）',
  '  README.md / DESIGN.md / LICENSE',
  '                      项目文档与开源许可（本包只含运行所需文件，不含源码）',
  ''
].join('\r\n');

const extra = [
  { name: '使用说明.txt', data: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(readmeTxt, 'utf8')]) }
];

// ---------- 5. 写 release/omni-translate/（解压后的样子） ----------
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
for (const f of files) {
  const rel = relative(root, f);
  const dest = join(stagingDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(f));
}
for (const e of extra) writeFileSync(join(stagingDir, e.name), e.data);

// ---------- 6. 手写 zip（无第三方依赖） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosStamp(d) {
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F),
    date: (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  };
}
function buildZip(entries) {
  const now = dosStamp(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034B50, 0);
    head.writeUInt16LE(20, 4);        // 解压所需版本 2.0
    head.writeUInt16LE(0x0800, 6);    // 通用标志：文件名是 UTF-8
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(now.time, 10);
    head.writeUInt16LE(now.date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);        // 无扩展字段
    parts.push(head, nameBuf, body);
    central.push({ nameBuf, method, crc, comp: body.length, size: e.data.length, offset });
    offset += 30 + nameBuf.length + body.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014B50, 0);
    h.writeUInt16LE(20, 4);           // version made by
    h.writeUInt16LE(20, 6);           // version needed
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(now.time, 12);
    h.writeUInt16LE(now.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.comp, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);           // 扩展字段长度
    h.writeUInt16LE(0, 32);           // 注释长度
    h.writeUInt16LE(0, 34);           // 起始磁盘号
    h.writeUInt16LE(0, 36);           // 内部属性
    h.writeUInt32LE(0x20, 38);        // 外部属性：普通文件
    h.writeUInt32LE(c.offset, 42);
    parts.push(h, c.nameBuf);
    offset += 46 + c.nameBuf.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);          // 注释长度
  parts.push(eocd);
  return Buffer.concat(parts);
}

const zipEntries = [
  ...files.map((f) => ({ name: `${pkgName}/${relative(root, f).split('\\').join('/')}`, data: readFileSync(f) })),
  ...extra.map((e) => ({ name: `${pkgName}/${e.name}`, data: e.data }))
];
const zipBuf = buildZip(zipEntries);
mkdirSync(releaseDir, { recursive: true });
writeFileSync(zipPath, zipBuf);

// ---------- 7. 回读校验：解出来的每个条目都要和源文件一致 ----------
const byName = new Map(zipEntries.map((e) => [e.name, e.data]));
function verifyZip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error('zip 结构损坏：找不到 EOCD');
  const count = buf.readUInt16LE(eocdPos + 10);
  let p = buf.readUInt32LE(eocdPos + 16);
  if (count !== zipEntries.length) throw new Error(`条目数不符：${count} != ${zipEntries.length}`);
  const seen = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (data.length !== size) throw new Error(`${name} 大小不符`);
    if (crc32(data) !== crc) throw new Error(`${name} CRC 不符`);
    const src = byName.get(name);
    if (!src) throw new Error(`${name} 不在源文件列表里`);
    if (createHash('sha256').update(data).digest('hex') !== createHash('sha256').update(src).digest('hex')) {
      throw new Error(`${name} 内容与源文件不一致`);
    }
    seen.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return seen;
}
const names = verifyZip(zipBuf);

// ---------- 8. 结果 ----------
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const rawTotal = zipEntries.reduce((s, e) => s + e.data.length, 0);
console.log('');
console.log(`[pack] 版本 v${version} · ${names.length} 个文件 · 原始 ${mb(rawTotal)} → 压缩后 ${mb(zipBuf.length)}`);
console.log(`[pack] 解压目录: ${stagingDir}`);
console.log(`[pack] 待发送文件: ${zipPath}`);
console.log('');
console.log('下一步：把 zip 发给对方（微信/QQ/邮件均可，建议先自己解压试装一次）。');
console.log('本地想验证「解压出来的目录」真能用，可跑：npm run verify:pack');

// ---------- 9. 可选：拿 e2e 直接验证解压目录 ----------
if (verify) {
  console.log('\n[pack] 用 e2e 验证解压目录（会打开一个 Chromium 窗口）…');
  const ext = stagingDir;
  const r = spawnSync(process.execPath, [join(root, 'tests', 'e2e', 'run.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, OT_EXT_PATH: ext }
  });
  if (r.status !== 0) { console.error('[pack] e2e 未通过（见上面的 FAIL 行）'); process.exit(1); }
  console.log('[pack] e2e 全部通过：解压出来的目录可以直接加载使用。');
}
