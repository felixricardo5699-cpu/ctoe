#!/usr/bin/env node
/**
 * Boots the built app, checks that the renderer actually rendered, then exits.
 * Usage: npm run smoke            (add flags after -- , e.g. npm run smoke -- --disable-gpu)
 *
 * App data is redirected into .cache/smoke-data so a smoke run can never touch
 * your real settings or API key.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const dataDir = join(projectRoot, '.cache', 'smoke-data')
mkdirSync(dataDir, { recursive: true })
// My Learning has to start empty: the run learns a sentence and then checks what that wrote, and
// a note left over from an earlier run would make the check pass (or count as the sentence it
// was going to file). Only this file is dropped - the settings in the same directory stay, so
// the run still exercises a real, configured app.
rmSync(join(dataDir, 'learned.json'), { force: true })
// The recent list is checked the same way, so it starts empty as well.
rmSync(join(dataDir, 'recent.json'), { force: true })

const result = spawnSync(electronPath, [projectRoot, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, CTOE_SMOKE: '1', CTOE_DATA_DIR: dataDir }
})

process.exit(result.status ?? 1)
