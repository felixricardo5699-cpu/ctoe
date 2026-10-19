import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_HOST,
  BRIDGE_MAX_TEXT_CHARS,
  BRIDGE_MODES,
  BRIDGE_PORT_FIRST,
  BRIDGE_PORT_LAST,
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL_VERSION
} from '@shared/types/bridge'

/*
 * The extension and the app are one product now, but they are still two programs talking over a
 * socket: the constants that describe that socket exist twice, once in TypeScript and once in the
 * extension's plain JavaScript. Nothing at compile time connects them.
 *
 * This is the seam that has to be checked, and it is checked here rather than in the extension's
 * own test run because this is the side that ships first when someone bumps a port or a limit.
 * The version assertion is the other half of "两个东西是同一个版本": the root package.json is the
 * only version a human edits, `npm run build:extension` copies it into the manifest, and a mismatch
 * fails this test rather than producing an installer whose plugin is older than the app.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const extensionRoot = fileURLToPath(new URL('../../../../extension/', import.meta.url))

interface ExtensionBridgeModule {
  BRIDGE_HOST: string
  BRIDGE_PORT_FIRST: number
  BRIDGE_PORT_LAST: number
  BRIDGE_PORTS: readonly number[]
  BRIDGE_PROTOCOL_VERSION: number
  BRIDGE_MAX_TEXT_CHARS: number
  BRIDGE_MODES: readonly string[]
  WAKE_URL: string
}

async function loadExtensionBridge(): Promise<ExtensionBridgeModule> {
  // Loaded through the file URL so this works the same on Windows and in CI, and so the extension
  // module is the exact one that ends up inside the package.
  return (await import(new URL('../../../../extension/src/core/bridge.mjs', import.meta.url).href)) as ExtensionBridgeModule
}

describe('extension contract: the wire the two programs share', () => {
  it('agrees on the host, the port range and the protocol version', async () => {
    const bridge = await loadExtensionBridge()

    expect(bridge.BRIDGE_HOST).toBe(BRIDGE_HOST)
    expect(bridge.BRIDGE_PORT_FIRST).toBe(BRIDGE_PORT_FIRST)
    expect(bridge.BRIDGE_PORT_LAST).toBe(BRIDGE_PORT_LAST)
    expect([...bridge.BRIDGE_PORTS]).toEqual([...BRIDGE_PORTS])
    expect(bridge.BRIDGE_PROTOCOL_VERSION).toBe(BRIDGE_PROTOCOL_VERSION)
  })

  it('agrees on what a request may carry', async () => {
    const bridge = await loadExtensionBridge()

    expect(bridge.BRIDGE_MAX_TEXT_CHARS).toBe(BRIDGE_MAX_TEXT_CHARS)
    expect([...bridge.BRIDGE_MODES]).toEqual([...BRIDGE_MODES])
    // The doorbell is a scheme, not data: the extension rings it and the app answers it by name.
    expect(bridge.WAKE_URL).toBe('ctoe://wake')
  })

  it('ships the same version as the app', () => {
    const app = JSON.parse(readFileSync(repoRoot + 'package.json', 'utf8')) as { version: string }
    const manifest = JSON.parse(readFileSync(extensionRoot + 'manifest.json', 'utf8')) as {
      version: string
    }

    // If this fails, run `npm run sync:version` (or `npm run build:extension`, which does it):
    // the package would otherwise carry a plugin built from a different release.
    expect(manifest.version).toBe(app.version)
  })
})
