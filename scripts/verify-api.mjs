#!/usr/bin/env node
/**
 * Sends one real translation through whatever is configured in the app, then exits.
 *
 *   npm run verify:api                       # uses the saved settings + key
 *   npm run verify:api -- "我觉得这个说法太绝对了。"
 *   npm run verify:api -- --no-sandbox        # extra flags go to electron
 *
 * It deliberately does NOT redirect the app data directory: the point is to validate the
 * exact config.json, API key, endpoint and model the real app will use.
 * The API key is never printed - only whether it is present and how long it is.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(projectRoot, 'out', 'main', 'index.js')

if (!existsSync(entry)) {
  console.error('verify:api needs a build first - run: npm run build')
  process.exit(2)
}

const argv = process.argv.slice(2)
const flags = argv.filter((argument) => argument.startsWith('-'))
const text = argv.filter((argument) => !argument.startsWith('-')).join(' ').trim()

const env = { ...process.env, CTOE_VERIFY_API: '1' }
delete env.CTOE_DATA_DIR
delete env.CTOE_SMOKE
if (text.length > 0) env.CTOE_VERIFY_TEXT = text

const electronPath = require('electron')
const result = spawnSync(electronPath, [projectRoot, ...flags], {
  cwd: projectRoot,
  stdio: 'inherit',
  env
})

process.exit(result.status ?? 1)
