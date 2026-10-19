#!/usr/bin/env node
/**
 * Drops the Chromium runtime parts this app never loads, after electron-builder has staged the
 * app directory and before it is packed into an installer.
 *
 * The four files are here because the renderer is plain DOM: no WebGPU (dxcompiler), no WebGL
 * fallback through software Vulkan (vk_swiftshader), and no media playback (ffmpeg). They cost
 * about 33MB unpacked, which is roughly 8MB in the installer.
 *
 * It runs by default, because the A/B measurement on this app was unambiguous: 96.5MB -> 89.2MB
 * installer, and the packaged smoke test (which lays out and renders the real panel) passes without
 * them. `CTOE_KEEP_RUNTIME=1` builds a full runtime instead, for a machine where one of the four
 * turns out to be needed.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Files that only matter for features this app does not use. */
const REMOVABLE = [
  'dxcompiler.dll', // D3D12 / WebGPU shader compiler
  'vk_swiftshader.dll', // software Vulkan fallback
  'vk_swiftshader_icd.json', // its manifest; a dangling manifest is worse than neither
  'ffmpeg.dll' // audio/video decoding
]

export async function afterPack(context) {
  if (process.env.CTOE_KEEP_RUNTIME === '1') return
  const removed = []
  for (const name of REMOVABLE) {
    const path = join(context.appOutDir, name)
    if (!existsSync(path)) continue
    rmSync(path)
    removed.push(name)
  }
  if (removed.length > 0) console.log('  • 移除未使用的运行时组件：' + removed.join('、'))
}
