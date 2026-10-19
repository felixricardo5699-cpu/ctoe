// 把 OCR 组件预置到 vendor/tesseract，实现完全离线（不依赖运行时 CDN）。
// 组件来源：
//   - 主脚本/worker：npm 包 tesseract.js 的 dist
//   - 核心 wasm：npm 包 tesseract.js-core（tesseract.js 的固定依赖）
//   - 语言包：tessdata_fast（LSTM，体积小）eng / chi_sim / chi_tra
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const vendor = join(root, 'vendor', 'tesseract');
const LANGS = ['eng', 'chi_sim', 'chi_tra'];

// traineddata 校验：非 HTML/错误页 + 有足够体积（现代格式无固定 TIFF 头）
function looksLikeTraineddata(buf) {
  if (!buf || buf.length < 64 * 1024) return false;
  const head = buf.subarray(0, 128).toString('latin1').toLowerCase();
  if (head.includes('<!doctype html') || head.includes('<html') || head.includes('404: not found') || head.includes('not found') && head.length < 64) return false;
  return true;
}

const MIRRORS = (lang) => [
  `https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/${lang}.traineddata`,
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`
];

async function downloadWithRetry(lang) {
  let lastErr = null;
  for (const url of MIRRORS(lang)) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} ${url}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeTraineddata(buf)) { lastErr = new Error(`bad traineddata magic from ${url}`); continue; }
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`download failed: ${lang}`);
}

async function ensureNpmPkg() {
  try { execSync('npm ls tesseract.js --depth=0', { cwd: root, stdio: 'pipe' }); } catch (_) {
    console.log('[fetch-ocr] installing tesseract.js ...');
    execSync('npm i -D tesseract.js@4', { cwd: root, stdio: 'inherit' });
  }
}

async function main() {
  await ensureNpmPkg();
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(join(vendor, 'core'), { recursive: true });
  mkdirSync(join(vendor, 'langs'), { recursive: true });

  // 1) tesseract.js 主脚本与 web worker
  const tessDist = join(root, 'node_modules', 'tesseract.js', 'dist');
  for (const f of ['tesseract.min.js', 'worker.min.js']) {
    const s = join(tessDist, f);
    if (existsSync(s)) { copyFileSync(s, join(vendor, f)); console.log(`[fetch-ocr] copy ${f}`); }
    else throw new Error(`missing ${s}`);
  }

  // 2) tesseract.js-core 的 wasm 核心（tesseract.js 固定依赖，离线可获）
  const coreSrc = join(root, 'node_modules', 'tesseract.js-core');
  if (!existsSync(coreSrc)) throw new Error('node_modules/tesseract.js-core not found (npm install first)');
  let copiedCore = 0;
  for (const f of readdirSync(coreSrc)) {
    if (/^tesseract-core.*(\.wasm(\.js)?|\.js)$/.test(f) || /\.js$/.test(f)) {
      if (f === 'index.js') continue; // 浏览器不适用
      copyFileSync(join(coreSrc, f), join(vendor, 'core', f));
      copiedCore++;
    }
  }
  console.log(`[fetch-ocr] core files copied: ${copiedCore}`);

  // 3) 语言包（本地离线 OCR 用；扩展默认 eng，中文可切换 chi_sim/chi_tra）
  for (const l of LANGS) {
    const buf = await downloadWithRetry(l);
    writeFileSync(join(vendor, 'langs', `${l}.traineddata`), buf);
    console.log(`[fetch-ocr] ${l}.traineddata 已保存 (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  // 汇总校验
  const expect = [...LANGS.map((l) => join(vendor, 'langs', `${l}.traineddata`)), join(vendor, 'core', 'tesseract-core-simd.wasm.js'), join(vendor, 'core', 'tesseract-core.wasm.js'), join(vendor, 'worker.min.js'), join(vendor, 'tesseract.min.js')];
  const missing = expect.filter((p) => !existsSync(p) || statSync(p).size === 0);
  if (missing.length) throw new Error('missing/empty: ' + missing.join(', '));
  console.log('[fetch-ocr] done -> vendor/tesseract（离线 OCR 组件就绪：eng / chi_sim / chi_tra + 核心）');
}

main().catch((e) => { console.error('[fetch-ocr] 失败:', e && e.message ? e.message : e); process.exit(1); });