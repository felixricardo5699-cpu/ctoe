#!/usr/bin/env node
/**
 * Removes everything this repository builds or downloads, and nothing else.
 *
 * The app produces five kinds of by-product - an Electron build, a packaged release, the
 * extension's own build, tesseract's 24MB of downloaded OCR data, and smoke-test data - and after
 * a few rounds of development they are the part of the checkout that keeps growing. `clean`
 * deletes them in one step so "which of these is the current version" never has to be answered by
 * hand again.
 *
 * Build caches under `.cache/electron*` are kept on purpose: they make the next packaging run
 * fast and are shared by every release, not tied to one.
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const targets = [
  'out',
  'release',
  'build/extension', // 旧的中转目录，已经不产出；清掉历史残留
  'extension/dist',
  'extension/release',
  'extension/node_modules',
  'extension/vendor/tesseract',
  '.cache/smoke-data',
  '.cache/extension-build',
  '.cache/packaged-smoke',
  '.cache/packaged-smoke2',
  'tsconfig.node.tsbuildinfo',
  'tsconfig.web.tsbuildinfo'
]

let removed = 0
for (const target of targets) {
  const path = join(root, target)
  if (!existsSync(path)) continue
  rmSync(path, { recursive: true, force: true })
  removed += 1
  console.log('· 删除 ' + relative(root, path))
}

console.log(removed === 0 ? '✓ 已经是干净状态' : '✓ 清理完成（' + removed + ' 项）')
