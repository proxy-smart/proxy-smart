/**
 * MCP Endpoint Config — Unit Tests
 *
 * Tests the file-backed config persistence for:
 *  - isToolExposed: allowlist vs blocklist modes
 *  - isResourceExposed follows same logic as tools
 *  - Edge cases: empty allowlist blocks everything, null enabledTools uses blocklist
 *  - saveMcpEndpointConfig updates timestamp and file
 *
 * NOTE: Config is persisted via the shared admin-config store. In the no-DB
 * (file-fallback) test environment, `saveMcpEndpointConfig` updates the store's
 * short-TTL cache synchronously and writes the JSON file asynchronously, so
 * tests that assert on the file contents must AWAIT the save first. Sync reads
 * (`loadMcpEndpointConfig` / `isToolExposed`) observe the new value immediately
 * without awaiting because the cache is updated synchronously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  loadMcpEndpointConfig,
  saveMcpEndpointConfig,
  isToolExposed,
  isResourceExposed,
} from '../src/lib/mcp-endpoint-config'
import { DATA_DIR } from '../src/lib/paths'

const CONFIG_PATH = join(DATA_DIR, 'mcp-endpoint.json')

// ── Backup / restore ─────────────────────────────────────────────────────────

let originalContent: string | null = null

function backupConfig() {
  if (existsSync(CONFIG_PATH)) {
    originalContent = readFileSync(CONFIG_PATH, 'utf-8')
  } else {
    originalContent = null
  }
}

async function restoreConfig() {
  if (originalContent !== null) {
    writeFileSync(CONFIG_PATH, originalContent, 'utf-8')
    // Also update the store cache + durable backend
    try {
      await saveMcpEndpointConfig(JSON.parse(originalContent))
    } catch {
      // If original was invalid JSON, reset to defaults
      await saveMcpEndpointConfig({
        enabled: true,
        disabledTools: [],
        enabledTools: null,
        exposeResourcesAsTools: true,
        updatedAt: new Date().toISOString(),
      })
    }
  } else if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH)
    // Reset the store cache to defaults
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP Endpoint Config — isToolExposed', () => {
  beforeEach(() => {
    backupConfig()
  })

  afterEach(async () => {
    await restoreConfig()
  })

  it('exposes all tools in default blocklist mode (empty blocklist)', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    expect(isToolExposed('any_tool_name')).toBe(true)
    expect(isToolExposed('search_documentation')).toBe(true)
  })

  it('blocks tools in the disabledTools blocklist', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: ['dangerous_tool', 'another_tool'],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    expect(isToolExposed('dangerous_tool')).toBe(false)
    expect(isToolExposed('another_tool')).toBe(false)
    expect(isToolExposed('safe_tool')).toBe(true)
  })

  it('allowlist mode: only enabled tools are exposed', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: ['tool_a', 'tool_b'],
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    expect(isToolExposed('tool_a')).toBe(true)
    expect(isToolExposed('tool_b')).toBe(true)
    expect(isToolExposed('tool_c')).toBe(false)
  })

  it('allowlist takes priority over blocklist', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: ['tool_a'], // also in blocklist
      enabledTools: ['tool_a', 'tool_b'], // allowlist overrides
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    // tool_a is in both — allowlist wins
    expect(isToolExposed('tool_a')).toBe(true)
    // tool_c is not in allowlist — blocked even though not in blocklist
    expect(isToolExposed('tool_c')).toBe(false)
  })

  it('empty allowlist blocks ALL tools', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: [],
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    expect(isToolExposed('any_tool')).toBe(false)
    expect(isToolExposed('search_documentation')).toBe(false)
  })

  it('isResourceExposed follows same logic as isToolExposed', async () => {
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: ['blocked_resource'],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    expect(isResourceExposed('blocked_resource')).toBe(false)
    expect(isResourceExposed('allowed_resource')).toBe(true)
  })
})

describe('MCP Endpoint Config — saveMcpEndpointConfig', () => {
  beforeEach(() => {
    backupConfig()
  })

  afterEach(async () => {
    await restoreConfig()
  })

  it('persists config to mcp-endpoint.json', async () => {
    await saveMcpEndpointConfig({
      enabled: false,
      disabledTools: ['test_tool'],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: '', // should be overwritten
    })

    expect(existsSync(CONFIG_PATH)).toBe(true)
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    expect(raw.enabled).toBe(false)
    expect(raw.disabledTools).toEqual(['test_tool'])
    expect(raw.updatedAt).not.toBe('')
  })

  it('updates the updatedAt timestamp', async () => {
    const before = new Date().toISOString()
    await saveMcpEndpointConfig({
      enabled: true,
      disabledTools: [],
      enabledTools: null,
      exposeResourcesAsTools: true,
      updatedAt: '2020-01-01T00:00:00Z',
    })

    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    expect(new Date(raw.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
  })

  it('saved config is immediately visible via loadMcpEndpointConfig', () => {
    // Unawaited on purpose: the store updates its cache synchronously, so a sync
    // read reflects the write immediately even before the durable write resolves.
    void saveMcpEndpointConfig({
      enabled: false,
      disabledTools: ['x'],
      enabledTools: ['y'],
      exposeResourcesAsTools: true,
      updatedAt: new Date().toISOString(),
    })

    const cfg = loadMcpEndpointConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.disabledTools).toEqual(['x'])
    expect(cfg.enabledTools).toEqual(['y'])
  })
})
