#!/usr/bin/env node
/**
 * Builds the extension that ships inside the installer: `extension/src` -> `extension/dist`.
 *
 * The extension is part of this repository now, so there is no copying, no patching and no
 * second source tree: the build is its own script, run from its own folder, and its output stays
 * there. What is added here is the part that only the packaging side knows about - the version
 * the manifest must carry - and the guard that stops a release from shipping a half-built plugin.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extension = join(root, 'extension')

const fail = (message) => {
  console.error('✗ ' + message)
  process.exit(1)
}

const run = (args, options) => {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    fail('命令失败：node ' + args.join(' '))
  }
}

// 1) 版本对齐：插件和软件永远是同一个版本号
run([join(root, 'scripts', 'sync-version.mjs')])

// 2) 构建（扩展自己的 build.mjs；esbuild 用仓库根部的依赖）
const build = join(extension, 'build.mjs')
if (!existsSync(build)) fail('找不到 extension/build.mjs')
run([build], { cwd: extension })

// 3) 守门：manifest、service worker、内容脚本必须在，且非空
const required = ['manifest.json', 'dist/sw.mjs', 'dist/content.js']
const missing = required.filter((name) => {
  const path = join(extension, name)
  return !existsSync(path) || statSync(path).size === 0
})
if (missing.length > 0) fail('扩展构建产物不完整，缺少：' + missing.join('、'))

// 4) OCR 组件不在 git 里（24MB 的词库），要在本机预置过；缺了是功能缺失，不是构建错误，
//    所以默认拦下，明确告诉要跑哪条命令，允许用 CTOE_ALLOW_MISSING_OCR=1 跳过。
const ocr = join(extension, 'vendor', 'tesseract', 'tesseract.min.js')
if (!existsSync(ocr) && process.env.CTOE_ALLOW_MISSING_OCR !== '1') {
  fail(
    '缺少离线 OCR 组件（extension/vendor/tesseract）。先运行 `npm run fetch:ocr`（需要联网一次），' +
      '或设置 CTOE_ALLOW_MISSING_OCR=1 打一个不带图片翻译的包。'
  )
}

const size = ['dist', 'vendor']
  .filter((name) => existsSync(join(extension, name)))
  .reduce((total, name) => total + measure(join(extension, name)), 0)
console.log('✓ 扩展就绪：extension/（' + (size / 1048576).toFixed(1) + ' MB，版本 ' + version() + '）')

function version() {
  return JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version
}

function measure(folder) {
  let total = 0
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry)
    total += statSync(full).isDirectory() ? measure(full) : statSync(full).size
  }
  return total
}
