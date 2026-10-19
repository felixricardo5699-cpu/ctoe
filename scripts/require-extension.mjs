#!/usr/bin/env node
/**
 * Stops a packaging run that would ship the app without a usable browser extension.
 *
 * `extraResources` points at `extension/`, and electron-builder treats a missing `from` as a line
 * of log rather than a failure: it prints `file source doesn't exist` and still exits 0. A release
 * built that way installs fine and then tells the user this version 没有带上浏览器扩展 - a
 * mistake nobody sees until the installer is already out.
 *
 * It runs as the `beforePack` hook rather than as one more step in `build:win` so that every way of
 * starting a package is covered: the npm script, `npx electron-builder`, and whatever a later CI
 * job turns out to be.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The least a folder needs to be an extension a browser will load: the manifest, and the service
 * worker that manifest names (`background: { service_worker: dist/sw.mjs }`). Everything else it
 * points at - options, content script, popup - is written into the same `dist` by the extension's
 * own build, so a `dist` that holds one holds all of them.
 */
const REQUIRED = ['manifest.json', 'dist/sw.mjs', 'dist/content.js']

export async function beforePack() {
  const folder = join(root, 'extension')
  const missing = REQUIRED.filter((name) => {
    const path = join(folder, name)
    return !existsSync(path) || statSync(path).size === 0
  })

  if (missing.length > 0) {
    throw new Error(
      '安装包必须带上浏览器扩展，但 extension/ 里缺少：' +
        missing.join('、') +
        '。请先跑 `npm run build:extension`，再重新打包。'
    )
  }

  // OCR 词库是下载来的（不在 Git 里）。缺了的话安装包里的“翻译图片”会不可用，提前说清楚。
  if (!existsSync(join(folder, 'vendor', 'tesseract', 'tesseract.min.js'))) {
    console.warn(
      '⚠ extension/vendor/tesseract 不存在：这个包里的图片翻译（OCR）将不可用。' +
        '需要的话先跑 `npm run fetch:ocr`。'
    )
  }
}
