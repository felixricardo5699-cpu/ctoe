// ============ 离屏文档：图片 OCR → 返回文字行（含 bbox） ============
const VENDOR = 'vendor/tesseract';
const TESS_SRC = ['tesseract.min.js', 'tesseract.js'].find((f) => true); // 占位，运行时探测

function b64ToBlob(dataUrl) {
  const idx = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, idx);
  const mime = meta.split(';')[0] || 'image/png';
  const b64 = dataUrl.slice(idx + 1);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('load fail ' + src));
    document.head.appendChild(s);
  });
}

function getFileUrl(name) { return chrome.runtime.getURL(`${VENDOR}/${name}`); }

let tessReady = null;
async function loadTesseract() {
  if (tessReady) return tessReady;
  tessReady = (async () => {
    const names = ['tesseract.min.js', 'worker.min.js', 'core/tesseract-core.wasm.js', 'core/tesseract-core-simd.wasm.js', 'langs/eng.traineddata'];
    const probe = await Promise.all(names.map(async (n) => {
      try { const r = await fetch(getFileUrl(n), { method: 'HEAD' }); return r.ok ? n : null; } catch (_) { return null; }
    }));
    const miss = names.filter((n) => !probe.includes(n));
    if (miss.length) {
      throw new Error('OCR 离线组件缺失: ' + miss.join(', ') + ' 。请在扩展目录运行 `npm install && npm run fetch-ocr` 后重新加载扩展。');
    }
    await loadScript(getFileUrl('tesseract.min.js'));
    if (typeof window.Tesseract === 'undefined' && typeof globalThis.Tesseract === 'undefined') {
      throw new Error('tesseract 加载失败');
    }
    return true;
  })();
  return tessReady;
}

// tesseract.js v4：createWorker({ langs, oem, workerPath, corePath, langPath }) 单对象签名
const workerCache = new Map();
async function getWorker(lang = 'eng') {
  const key = String(lang || 'eng');
  if (workerCache.has(key)) return workerCache.get(key);
  const p = (async () => {
    const T = window.Tesseract || globalThis.Tesseract;
    const w = await T.createWorker({
      workerPath: getFileUrl('worker.min.js'),
      corePath: getFileUrl('core'),
      langPath: getFileUrl('langs'),
      workerBlobURL: false,
      gzip: false, // 本地语言包为未压缩 .traineddata
      logger: () => {}
    });
    await w.loadLanguage(key);
    await w.initialize(key, 1);
    await w.setParameters({ tessedit_pageseg_mode: '6' }); // block 模式，适合整图
    return w;
  })();
  workerCache.set(key, p);
  try { await p; } catch (e) { workerCache.delete(key); throw e; }
  return workerCache.get(key);
}

function normalizeBlocks(data) {
  // 兼容 v4/v5：收集 line 文本 + bbox
  const lines = [];
  const walk = (arr, bbox) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item) continue;
      if (item.text && item.bbox && (item.words || item.symbols)) {
        lines.push({ text: item.text.trim(), bbox: item.bbox });
      } else if (item.paragraphs) walk(item.paragraphs, item.bbox);
      else if (item.lines) walk(item.lines, item.bbox);
      else if (item.words && item.words[0] && item.words[0].bbox) {
        const joined = (item.words || []).map((wd) => wd.text).join(' ');
        if (joined.trim()) lines.push({ text: joined.trim(), bbox: item.bbox });
      }
    }
  };
  walk(data.blocks, null);
  if (!lines.length && data.lines) {
    for (const l of data.lines) if (l.text && l.bbox) lines.push({ text: l.text.trim(), bbox: l.bbox });
  }
  if (!lines.length && data.words) {
    // 退化：按词
    for (const wd of data.words) if (wd.text && wd.bbox) lines.push({ text: wd.text, bbox: wd.bbox });
  }
  return lines;
}

async function doOcr(job, dataUrl, lang, ocrModeArg) {
  const blob = b64ToBlob(dataUrl);
  const bmp = await createImageBitmap(blob);
  const naturalWidth = bmp.width;
  const naturalHeight = bmp.height;
  let lines = [];
  const ocrMode = ocrModeArg;

  if (ocrMode === 'mock' || (job && job.indexOf('mock') === 0)) {
    // E2E mock：在中部给两条假 OCR 行
    lines = [
      { text: 'OmniTranslate image translation works', bbox: { x0: naturalWidth * 0.08, y0: naturalHeight * 0.42, x1: naturalWidth * 0.92, y1: naturalHeight * 0.52 } },
      { text: 'Second mock line for testing', bbox: { x0: naturalWidth * 0.2, y0: naturalHeight * 0.6, x1: naturalWidth * 0.8, y1: naturalHeight * 0.68 } }
    ];
  } else {
    try {
      await loadTesseract();
      const w = await getWorker(lang || 'eng');
      const { data } = await w.recognize(blob);
      lines = normalizeBlocks(data);
    } catch (e) {
      return { ok: false, error: (e && (e.stack || e.message || String(e))).slice(0, 1500) };
    } finally {
      try { bmp.close && bmp.close(); } catch (_) {}
    }
  }
  return { ok: true, lines, naturalWidth, naturalHeight };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ot-ocr') return;
  const { job, image, langs, ocrMode } = msg;
  doOcr(job, image, langs, ocrMode).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});