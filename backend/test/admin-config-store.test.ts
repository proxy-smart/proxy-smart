/**
 * Admin Config Store — Unit Tests (file-fallback path)
 *
 * Exercises the shared, generic key→JSON admin-config store without a database
 * (no DATABASE_URL), i.e. the file backend used for local dev and the current
 * beta deployment. The Postgres path is covered by integration when a DB is
 * available; here we verify the behaviour every task relies on:
 *
 *  - sync reads served from the cache, applying defaults + merge
 *  - writes update the cache synchronously (visible before the durable write)
 *  - writes persist to DATA_DIR/<key>.json (awaitable durability)
 *  - reload() picks up out-of-band changes (simulating another task's write)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  adminConfigStore,
  AdminConfigStore,
  type AdminConfigBackend,
  type AdminConfigValue,
} from '../src/lib/admin-config-store'
import { DATA_DIR } from '../src/lib/paths'

interface SampleConfig {
  enabled: boolean
  items: string[]
  updatedAt: string
}

const KEY = 'test-admin-config'
const FILE = join(DATA_DIR, `${KEY}.json`)

const DEFAULTS: SampleConfig = { enabled: true, items: [], updatedAt: 'never' }

function merge(defaults: SampleConfig, raw: Record<string, unknown> | null): SampleConfig {
  if (!raw) return { ...defaults }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    items: Array.isArray(raw.items) ? (raw.items as string[]) : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : defaults.updatedAt,
  }
}

afterEach(() => {
  adminConfigStore.invalidate(KEY)
  if (existsSync(FILE)) unlinkSync(FILE)
})

describe('AdminConfigStore — file fallback', () => {
  it('uses the file backend when DATABASE_URL is unset', () => {
    expect(adminConfigStore.durable).toBe(false)
  })

  it('returns defaults when nothing is persisted', () => {
    const cfg = adminConfigStore.get<SampleConfig>(KEY, DEFAULTS, merge)
    expect(cfg.enabled).toBe(true)
    expect(cfg.items).toEqual([])
  })

  it('write is visible synchronously via a subsequent get (before durable write resolves)', () => {
    // Do not await: the cache must be updated synchronously inside set().
    void adminConfigStore.set(KEY, { enabled: false, items: ['a'], updatedAt: 'now' })
    const cfg = adminConfigStore.get<SampleConfig>(KEY, DEFAULTS, merge)
    expect(cfg.enabled).toBe(false)
    expect(cfg.items).toEqual(['a'])
  })

  it('persists to DATA_DIR/<key>.json when awaited', async () => {
    await adminConfigStore.set(KEY, { enabled: false, items: ['x', 'y'], updatedAt: 'now' })
    expect(existsSync(FILE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(FILE, 'utf-8'))
    expect(onDisk.enabled).toBe(false)
    expect(onDisk.items).toEqual(['x', 'y'])
  })

  it('applies defaults for missing/mis-typed persisted keys', async () => {
    writeFileSync(FILE, JSON.stringify({ items: 'not-an-array' }), 'utf-8')
    const cfg = await adminConfigStore.reload<SampleConfig>(KEY, DEFAULTS, merge)
    // enabled missing -> default true; items wrong type -> [] from merge
    expect(cfg.enabled).toBe(true)
    expect(cfg.items).toEqual([])
  })

  it('reload() observes an out-of-band file change (another task wrote it)', async () => {
    await adminConfigStore.set(KEY, { enabled: true, items: ['one'], updatedAt: 'now' })
    // Simulate a different task persisting a new value directly to the file.
    writeFileSync(
      FILE,
      JSON.stringify({ enabled: false, items: ['two'], updatedAt: 'later' }),
      'utf-8',
    )
    const cfg = await adminConfigStore.reload<SampleConfig>(KEY, DEFAULTS, merge)
    expect(cfg.enabled).toBe(false)
    expect(cfg.items).toEqual(['two'])
  })
})

/**
 * Backend that always throws — stands in for a Postgres backend whose database
 * is unreachable or does not exist yet (the beta failure mode: DATABASE_URL set
 * but the `proxy_smart` DB was never created on an existing data volume).
 */
class FailingBackend implements AdminConfigBackend {
  loadCalls = 0
  storeCalls = 0

  async load(_key: string): Promise<AdminConfigValue | null> {
    this.loadCalls++
    throw new Error('database "proxy_smart" does not exist')
  }

  async store(_key: string, _value: AdminConfigValue): Promise<void> {
    this.storeCalls++
    throw new Error('database "proxy_smart" does not exist')
  }
}

describe('AdminConfigStore — resilient fallback (Postgres down → file backend)', () => {
  const RKEY = 'test-admin-config-resilient'
  const RFILE = join(DATA_DIR, `${RKEY}.json`)

  afterEach(() => {
    if (existsSync(RFILE)) unlinkSync(RFILE)
  })

  it('set() does NOT throw when the Postgres primary fails and persists to the file fallback', async () => {
    const primary = new FailingBackend()
    const store = AdminConfigStore.withResilientBackend(primary)

    // The admin save path (saveMcpEndpointConfig) awaits set(); it must not 500.
    await store.set(RKEY, { enabled: false, items: ['fallback'], updatedAt: 'now' })

    // Primary was attempted (and failed), proving the fallback engaged.
    expect(primary.storeCalls).toBe(1)
    // Value persisted to the file fallback, not lost.
    expect(existsSync(RFILE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(RFILE, 'utf-8'))
    expect(onDisk.enabled).toBe(false)
    expect(onDisk.items).toEqual(['fallback'])
  })

  it('a subsequent read returns the file-persisted value (not a crash, not stale defaults)', async () => {
    const primary = new FailingBackend()
    const store = AdminConfigStore.withResilientBackend(primary)

    await store.set(RKEY, { enabled: false, items: ['persisted'], updatedAt: 'now' })

    // reload() goes through the resilient backend's load(): the primary throws,
    // the file fallback returns the value just written — no crash, no defaults.
    const cfg = await store.reload<SampleConfig>(RKEY, DEFAULTS, merge)
    expect(cfg.enabled).toBe(false)
    expect(cfg.items).toEqual(['persisted'])
    // The primary load was attempted before falling back.
    expect(primary.loadCalls).toBeGreaterThanOrEqual(1)
  })

  it('reads never throw when Postgres is down and nothing was persisted (returns defaults)', async () => {
    const primary = new FailingBackend()
    const store = AdminConfigStore.withResilientBackend(primary)

    // No prior write and no file on disk: fallback load returns null → defaults.
    const cfg = await store.reload<SampleConfig>(RKEY, DEFAULTS, merge)
    expect(cfg.enabled).toBe(DEFAULTS.enabled)
    expect(cfg.items).toEqual([])
  })

  it('stops reporting durable persistence once it has fallen back', async () => {
    const store = AdminConfigStore.withResilientBackend(new FailingBackend())
    await store.set(RKEY, { enabled: true, items: [], updatedAt: 'now' })
    expect(store.persistsDurably).toBe(false)
  })
})

/** In-memory primary with compare-and-set, standing in for the Postgres backend. */
class VersionedMemoryBackend implements AdminConfigBackend {
  value: AdminConfigValue | null = null
  version = 0
  casCalls = 0
  /** Runs once before the next compare-and-set, as another task's write would. */
  interleave: (() => void) | null = null

  async load(): Promise<AdminConfigValue | null> { return this.value }
  async store(_key: string, value: AdminConfigValue): Promise<void> { this.value = value; this.version++ }
  async loadVersioned() { return { value: this.value, version: this.version } }
  async storeIfVersion(_key: string, value: AdminConfigValue, expected: number): Promise<boolean> {
    this.casCalls++
    const concurrent = this.interleave
    this.interleave = null
    concurrent?.()
    if (expected !== this.version) return false
    this.value = value
    this.version++
    return true
  }
}

describe('AdminConfigStore — resilient wrapper keeps compare-and-set', () => {
  const CKEY = 'test-admin-config-cas'
  const append = (item: string) => (current: SampleConfig) => ({ ...current, items: [...current.items, item] })

  it('mutate goes through the primary\'s compare-and-set', async () => {
    const primary = new VersionedMemoryBackend()
    const store = AdminConfigStore.withResilientBackend(primary)
    await store.mutate(CKEY, DEFAULTS, merge, append('a'))
    expect(primary.casCalls).toBe(1)
    expect(primary.value?.items).toEqual(['a'])
  })

  it('keeps a concurrent write instead of overwriting it', async () => {
    const primary = new VersionedMemoryBackend()
    const store = AdminConfigStore.withResilientBackend(primary)
    primary.interleave = () => { primary.value = { ...DEFAULTS, items: ['from-another-task'] }; primary.version++ }
    await store.mutate(CKEY, DEFAULTS, merge, append('mine'))
    expect(primary.value?.items).toEqual(['from-another-task', 'mine'])
  })
})
