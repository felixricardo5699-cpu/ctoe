// esbuild 打包：content IIFE、sw/offscreen/popup/options ESM、复制静态文件、生成图标
// 输入 src/ → 输出 dist/：manifest.json 只引用 dist/ 与 vendor/，所以改完源码必须重跑 npm run build。
// 离线 OCR 组件（vendor/tesseract/）不在这里生成，用 npm run fetch-ocr 预置。
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateIcons } from './tools/gen-icons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const vendor = join(root, 'vendor', 'tesseract');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'icons'), { recursive: true });

const shared = {
  bundle: true,
  sourcemap: false,
  minifyWhitespace: false,
  logLevel: 'info',
  target: ['chrome116']
};

await esbuild.build({
  ...shared,
  entryPoints: [join(root, 'src', 'content.js')],
  outfile: join(dist, 'content.js'),
  format: 'iife',
  platform: 'browser'
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, 'src', 'background', 'service-worker.mjs')],
  outfile: join(dist, 'sw.mjs'),
  format: 'esm',
  platform: 'browser'
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, 'src', 'offscreen', 'main.mjs')],
  outfile: join(dist, 'offscreen.mjs'),
  format: 'esm',
  platform: 'browser'
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, 'src', 'popup', 'main.mjs')],
  outfile: join(dist, 'popup.js'),
  format: 'iife',
  platform: 'browser'
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, 'src', 'options', 'main.mjs')],
  outfile: join(dist, 'options.js'),
  format: 'iife',
  platform: 'browser'
});

// 静态资源拷贝：HTML 入口与样式表原样搬到 dist/（文件名/路径要和 manifest.json 里写的一致）
const copies = [
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/options/options.html', 'options.html'],
  ['src/ui/content.css', 'content.css'],
  ['src/ui/panel.css', 'panel.css']   // 可选：面板样式目前并入 content.css，文件不存在就跳过
];
for (const [from, to] of copies) {
  const f = join(root, from);
  if (existsSync(f)) copyFileSync(f, join(dist, to));
}

// 校验 manifest 可解析
JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// 图标
generateIcons(join(dist, 'icons'));

// tesseract vendor 提示
if (!existsSync(vendor)) console.warn('[build] vendor/tesseract 不存在: 图片OCR将在首次使用时提示在线获取（npm run fetch-ocr 可预置离线包）。');

console.log('[build] dist/ 就绪');
