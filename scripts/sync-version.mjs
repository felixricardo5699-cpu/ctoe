#!/usr/bin/env node
/**
 * One version number, everywhere.
 *
 * The app and the extension it ships with must never disagree: an installer is "the software plus
 * its plugin", and a plugin built from a different version of this repo is exactly how a
 * half-updated installation happens. So the root `package.json` is the only place a version is
 * written by hand, and this script copies it into the extension's manifest (and its package.json,
 * which the extension uses for its own release notes).
 *
 * It rewrites the file only when the value actually differs, so it is safe to run on every build:
 * a version bump produces one small diff that belongs in the same commit as the bump.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('✗ package.json 的 version 不是 x.y.z：' + String(version))
  process.exit(1)
}

const targets = [
  join(root, 'extension', 'manifest.json'),
  join(root, 'extension', 'package.json')
]

let changed = 0
for (const path of targets) {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(/("version"\s*:\s*")[^"]*(")/, '$1' + version + '$2')
  if (after === before) {
    console.log('· ' + path.slice(root.length + 1) + ' 已是 ' + version)
    continue
  }
  writeFileSync(path, after)
  changed += 1
  console.log('· ' + path.slice(root.length + 1) + ' → ' + version)
}

/**
 * 扩展的 lockfile 也有自己的 version 字段（npm 写的）。它不参与我们的构建，但留着一个旧版本号
 * 正是"存在多个版本"的那种噪音，所以一起对齐。只改根上的两处，依赖自己的版本一个字都不动。
 */
const lockPath = join(root, 'extension', 'package-lock.json')
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const rootMissing = lock.packages?.[''] !== undefined && lock.packages[''].version !== version
  if (lock.version !== version || rootMissing) {
    lock.version = version
    if (lock.packages?.[''] !== undefined) lock.packages[''].version = version
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
    changed += 1
    console.log('· extension/package-lock.json → ' + version)
  } else {
    console.log('· extension/package-lock.json 已是 ' + version)
  }
}

if (changed > 0) console.log('✓ 版本已对齐到 ' + version)
