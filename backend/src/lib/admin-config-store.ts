// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared admin-config store — durable, cluster-safe persistence for
 * runtime-mutable admin configuration (MCP endpoint settings, app-store
 * visibility, etc.).
 *
 * Backends, selected at construction time by the presence of DATABASE_URL:
 *
 *  - PostgreSQL (production / clustered): a single `admin_config` table keyed
 *    by `config_key`. All tasks share one database, so a write from any task
 *    is observed by every other task — no per-task divergence under scale-out,
 *    and no data loss on redeploy/restart. Mirrors the pattern in
 *    `mtls-store.ts` (lazy `CREATE TABLE IF NOT EXISTS`, shared `pg` Pool).
 *
 *  - File (local dev / no DATABASE_URL): read/write the existing
 *    `DATA_DIR/<key>.json` files. Keeps current behaviour unchanged so local
 *    dev and the current beta deployment work exactly as before.
 *
 * Resilience: when DATABASE_URL IS set the Postgres backend is wrapped in a
 * {@link ResilientAdminConfigBackend} that transparently falls back to the file
 * backend if Postgres is unreachable or its database does not exist yet (e.g.
 * the `proxy_smart` DB was never created on an existing data volume). This
 * guarantees admin writes never 500 and reads never crash even when the
 * database is temporarily unavailable; once Postgres recovers the next write
 * persists durably again. The fallback is logged once to avoid log-spam.
 *
 * Read model: the public read API is SYNCHRONOUS so existing sync consumers
 * (`config.mcp.enabled` getter, `isToolExposed` in tight registration loops,
 * the app-store route handlers) do not have to change. Reads are served from a
 * SHORT-TTL in-memory cache. When the cache is stale a background refresh is
 * kicked off (fire-and-forget) but the current cached value is returned
 * immediately. This guarantees every task converges on writes from other tasks
 * within `CACHE_TTL_MS` — replacing the old indefinite cache that never
 * re-read. Writes update the cache synchronously and then persist (awaitable),
 * so unawaited callers still read the new value immediately while awaiting
 * callers can confirm durability.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'
import { DATA_DIR } from './paths'
import { createSchema, getSharedPool, hasDatabaseUrl } from './pg-pool'
import { isRecord } from './type-guards'

/**
 * Short TTL for the read cache. Kept deliberately small so that, under
 * scale-out, a write performed by one task is observed by all other tasks
 * within this window. Must NOT be an indefinite cache (the bug this fixes).
 */
const CACHE_TTL_MS = 5_000

/** Compare-and-set attempts before giving up. Contention here is admins clicking, not a hot path. */
const MUTATE_MAX_ATTEMPTS = 5

/** A JSON-serialisable admin config value. */
export type AdminConfigValue = Record<string, unknown>

/** A config object's own fields, which is exactly what JSON persistence keeps. */
function toConfigValue(value: object): AdminConfigValue {
  return Object.fromEntries(Object.entries(value))
}

/** pg hands jsonb back parsed; anything but an object reads as unset. */
function storedObject(key: string, value: unknown): AdminConfigValue | null {
  if (isRecord(value)) return value
  logger.server.warn('Stored admin config is not a JSON object, treating as unset', { key })
  return null
}

/**
 * Storage backend interface for admin config values.
 * Implemented by both the Postgres and file backends.
 *
 * Exported as a dependency seam: tests construct an {@link AdminConfigStore}
 * with a custom backend (e.g. a failing primary) to exercise the resilient
 * fallback path without a real database.
 */
/** A stored value together with the revision it was read at, for compare-and-set. */
export interface VersionedAdminConfigValue {
  value: AdminConfigValue | null
  /** 0 when the key does not exist yet, so creating is just a compare-and-set from 0. */
  version: number
}

export interface AdminConfigBackend {
  /** Load the raw value for a key, or null if it has never been written. */
  load(key: string): Promise<AdminConfigValue | null>
  /** Persist the value for a key. */
  store(key: string, value: AdminConfigValue): Promise<void>
  /**
   * Read a value together with its revision. Optional: a backend without
   * compare-and-set omits this pair and {@link AdminConfigStore.mutate} serialises in-process.
   */
  loadVersioned?(key: string): Promise<VersionedAdminConfigValue>
  /**
   * Persist only while the stored revision is still `expectedVersion`.
   * False means another writer got there first and the caller must re-read and retry.
   */
  storeIfVersion?(key: string, value: AdminConfigValue, expectedVersion: number): Promise<boolean>
}

// ── File backend (local dev / no DATABASE_URL) ────────────────────────────────

/**
 * Reads/writes `DATA_DIR/<key>.json`. Preserves the exact on-disk format and
 * location used before this store existed, so existing seed files and the
 * current beta volume keep working unchanged.
 */
class FileAdminConfigBackend implements AdminConfigBackend {
  private pathFor(key: string): string {
    return join(DATA_DIR, `${key}.json`)
  }

  async load(key: string): Promise<AdminConfigValue | null> {
    return this.loadSync(key)
  }

  loadSync(key: string): AdminConfigValue | null {
    const path = this.pathFor(key)
    if (!existsSync(path)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (isRecord(parsed)) return parsed
      logger.server.warn(`${key}.json is not a JSON object, treating as unset`)
      return null
    } catch (error) {
      logger.server.warn(`Failed to read ${key}.json, treating as unset`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async store(key: string, value: AdminConfigValue): Promise<void> {
    writeFileSync(this.pathFor(key), JSON.stringify(value, null, 2), 'utf-8')
  }
}

// ── Postgres backend (production / clustered) ─────────────────────────────────

/**
 * Stores values in a single shared `admin_config` table. Lazily creates the
 * table on first use, exactly like `mtls-store.ts` initialises its table.
 */
class PostgresAdminConfigBackend implements AdminConfigBackend {
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    await createSchema(getSharedPool(), 'admin_config', [
      `CREATE TABLE IF NOT EXISTS admin_config (
        config_key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      // Added after the table existed; `version` makes a mutation safe with more than one writer.
      'ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1',
    ])
    this.initialized = true
    logger.info('security', 'PostgreSQL admin_config table initialized')
  }

  async load(key: string): Promise<AdminConfigValue | null> {
    await this.initialize()
    const result = await getSharedPool().query(
      'SELECT value FROM admin_config WHERE config_key = $1',
      [key],
    )
    if (result.rows.length === 0) return null
    return storedObject(key, result.rows[0].value)
  }

  async store(key: string, value: AdminConfigValue): Promise<void> {
    await this.initialize()
    await getSharedPool().query(
      `
      INSERT INTO admin_config (config_key, value, updated_at, version)
      VALUES ($1, $2, NOW(), 1)
      ON CONFLICT (config_key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW(),
        version = admin_config.version + 1
      `,
      [key, JSON.stringify(value)],
    )
  }

  async loadVersioned(key: string): Promise<VersionedAdminConfigValue> {
    await this.initialize()
    const result = await getSharedPool().query(
      'SELECT value, version FROM admin_config WHERE config_key = $1',
      [key],
    )
    if (result.rows.length === 0) return { value: null, version: 0 }
    // BIGINT arrives as a string from pg; a config revision never approaches Number.MAX_SAFE_INTEGER.
    return {
      value: storedObject(key, result.rows[0].value),
      version: Number(result.rows[0].version),
    }
  }

  /**
   * The whole point of this class for concurrent writers: the UPDATE only lands while the row is
   * still at the revision the caller read. Version 0 means "did not exist", so the insert is
   * conditional on nobody else having created it first.
   */
  async storeIfVersion(key: string, value: AdminConfigValue, expectedVersion: number): Promise<boolean> {
    await this.initialize()
    if (expectedVersion === 0) {
      const inserted = await getSharedPool().query(
        `
        INSERT INTO admin_config (config_key, value, updated_at, version)
        VALUES ($1, $2, NOW(), 1)
        ON CONFLICT (config_key) DO NOTHING
        `,
        [key, JSON.stringify(value)],
      )
      return (inserted.rowCount ?? 0) > 0
    }

    const updated = await getSharedPool().query(
      `
      UPDATE admin_config
         SET value = $2, updated_at = NOW(), version = version + 1
       WHERE config_key = $1 AND version = $3
      `,
      [key, JSON.stringify(value), expectedVersion],
    )
    return (updated.rowCount ?? 0) > 0
  }
}

// ── Resilient backend (Postgres primary, file fallback) ──────────────────────

/**
 * Wraps a primary (Postgres) backend with a file fallback. Every operation is
 * attempted against the primary first; if it throws — connection refused, the
 * database does not exist yet, an init/query error — the call transparently
 * delegates to the file backend instead of propagating the error. This keeps
 * admin writes from 500ing and reads from crashing while Postgres is
 * unavailable, while leaving the happy path (Postgres reachable) unchanged.
 *
 * Writes that fall back are persisted to disk, so a subsequent read returns the
 * value that was written rather than stale defaults. When Postgres later
 * recovers, the next successful write persists durably again.
 *
 * The fallback condition is logged only once (one-shot flag) to avoid emitting
 * a warning on every call while the database stays down.
 */
export class ResilientAdminConfigBackend implements AdminConfigBackend {
  private fellBackOnce = false

  constructor(
    private readonly primary: AdminConfigBackend,
    private readonly fallback: AdminConfigBackend,
  ) {}

  /** True once the primary backend has failed at least once. */
  get usingFallback(): boolean {
    return this.fellBackOnce
  }

  async load(key: string): Promise<AdminConfigValue | null> {
    try {
      return await this.primary.load(key)
    } catch (error) {
      this.noteFallback('load', key, error)
      return this.fallback.load(key)
    }
  }

  async store(key: string, value: AdminConfigValue): Promise<void> {
    try {
      await this.primary.store(key, value)
    } catch (error) {
      this.noteFallback('store', key, error)
      await this.fallback.store(key, value)
    }
  }

  /** The primary's compare-and-set; a fallback read carries version 0 and its write always lands. */
  async loadVersioned(key: string): Promise<VersionedAdminConfigValue> {
    if (this.primary.loadVersioned) {
      try {
        return await this.primary.loadVersioned(key)
      } catch (error) {
        this.noteFallback('load', key, error)
      }
    }
    return { value: await this.fallback.load(key), version: 0 }
  }

  async storeIfVersion(key: string, value: AdminConfigValue, expectedVersion: number): Promise<boolean> {
    if (this.primary.storeIfVersion) {
      try {
        return await this.primary.storeIfVersion(key, value, expectedVersion)
      } catch (error) {
        this.noteFallback('store', key, error)
      }
    }
    await this.fallback.store(key, value)
    return true
  }

  private noteFallback(op: 'load' | 'store', key: string, error: unknown): void {
    if (this.fellBackOnce) return
    this.fellBackOnce = true
    logger.warn(
      'security',
      'Postgres admin config backend unavailable — falling back to file backend. ' +
        'Admin config will persist to disk until the database is reachable again.',
      {
        operation: op,
        key,
        error: error instanceof Error ? error.message : String(error),
      },
    )
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/** Cache entry: the last known value plus the time it was loaded. */
interface CacheEntry {
  value: AdminConfigValue
  loadedAt: number
  /** Guards against overlapping background refreshes for the same key. */
  refreshing: boolean
}

/**
 * Generic key → JSON admin-config store. One shared instance backs every
 * admin config (MCP endpoint, app-store, …) so there is a single source of
 * truth and a single backend selection.
 */
export class AdminConfigStore {
  private readonly backend: AdminConfigBackend
  private readonly cache = new Map<string, CacheEntry>()
  /** One promise chain per key, so same-task mutations queue instead of interleaving. */
  private readonly mutations = new Map<string, Promise<void>>()
  /** True when persistence is durable across tasks/restarts (Postgres). */
  readonly durable: boolean

  /**
   * @param backend Optional explicit backend, a dependency seam for tests that
   *   need to exercise a specific backend (e.g. a resilient backend with a
   *   failing primary) without depending on DATABASE_URL at import time.
   *   When omitted, the backend is selected from the environment: a
   *   file-fallback-wrapped Postgres backend when a database is configured,
   *   otherwise the plain file backend.
   */
  constructor(backend?: AdminConfigBackend) {
    if (backend) {
      this.backend = backend
      this.durable = backend instanceof PostgresAdminConfigBackend
      return
    }

    if (hasDatabaseUrl()) {
      // Postgres is the durable primary, but wrap it so a missing/unreachable
      // database transparently degrades to the file backend instead of 500ing
      // admin writes (the proxy_smart DB may not exist on an existing volume).
      this.backend = new ResilientAdminConfigBackend(
        new PostgresAdminConfigBackend(),
        new FileAdminConfigBackend(),
      )
      this.durable = true
      logger.info(
        'security',
        'Admin config store initialized with PostgreSQL backend (file fallback enabled)',
      )
    } else {
      this.backend = new FileAdminConfigBackend()
      this.durable = false
      logger.warn(
        'security',
        'No DATABASE_URL configured, using file-backed admin config store (not shared across tasks)',
      )
    }
  }

  /** Whether writes are currently reaching the shared database rather than a task-local file. */
  get persistsDurably(): boolean {
    if (this.backend instanceof ResilientAdminConfigBackend) return this.durable && !this.backend.usingFallback
    return this.durable
  }

  /**
   * Construct a store for tests with an explicit primary + file fallback,
   * exercising the resilient path without a real database. The file fallback
   * uses the same on-disk format and {@link DATA_DIR} as production.
   */
  static withResilientBackend(primary: AdminConfigBackend): AdminConfigStore {
    return new AdminConfigStore(
      new ResilientAdminConfigBackend(primary, new FileAdminConfigBackend()),
    )
  }

  /**
   * Read a config value synchronously, applying `defaults` for any missing or
   * mis-typed keys via `merge`. Served from the short-TTL cache; a stale entry
   * triggers a background refresh but still returns immediately.
   *
   * @param key      Storage key (also the filename stem in file mode).
   * @param defaults Default value used before the first load completes and as
   *                 the base for merging persisted partials.
   * @param merge    Combines `defaults` with the raw persisted value into a
   *                 fully-typed result. Receives null before the first
   *                 successful load.
   */
  get<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): T {
    const entry = this.cache.get(key)

    if (!entry) {
      // First access: prime synchronously in file mode (the read is cheap and
      // synchronous on disk), and kick off an async load for the DB path.
      const primed = this.primeSync(key, defaults, merge)
      return primed
    }

    if (Date.now() - entry.loadedAt > CACHE_TTL_MS) {
      this.refreshInBackground(key, defaults, merge)
    }
    return merge(defaults, entry.value)
  }

  /**
   * Persist a config value. Updates the cache synchronously so subsequent
   * sync reads (even before this promise resolves) observe the new value, then
   * writes through to the backend.
   */
  async set<T extends object>(key: string, value: T): Promise<void> {
    const serialisable = toConfigValue(value)
    this.cache.set(key, { value: serialisable, loadedAt: Date.now(), refreshing: false })
    await this.backend.store(key, serialisable)
  }

  /**
   * Change a config value SAFELY when more than one task can write it.
   *
   * `set` is last-writer-wins over a whole document, and every caller that appends to a list was
   * doing read-then-set across a 5-second cache: publishing one app silently unpublished another,
   * because the writing task had never seen it. This reads the CURRENT value, applies `update`, and
   * writes only while the revision is unchanged — retrying when it is not.
   *
   * Falls back to a serialised read-modify-write when the backend cannot compare-and-set (the file
   * backend, which is single-task by definition). In-process calls are serialised per key either
   * way, so two requests on the SAME task cannot interleave.
   */
  async mutate<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
    update: (current: T) => T,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const { loadVersioned, storeIfVersion } = this.backend
      if (!loadVersioned || !storeIfVersion) {
        const raw = await this.backend.load(key)
        const next = update(merge(defaults, raw))
        await this.set(key, next)
        return next
      }

      for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
        const { value, version } = await loadVersioned.call(this.backend, key)
        const next = update(merge(defaults, value))
        const serialisable = toConfigValue(next)
        const written = await storeIfVersion.call(this.backend, key, serialisable, version)
        if (written) {
          this.cache.set(key, { value: serialisable, loadedAt: Date.now(), refreshing: false })
          return next
        }
        // Someone else wrote between our read and our write; re-read and reapply on their result.
        logger.debug('security', 'admin config mutation retrying after a concurrent write', { key, attempt })
      }

      throw new Error(`Could not update admin config '${key}': too many concurrent writers`)
    }

    // Chain per key so concurrent callers in THIS task queue rather than race each other.
    const queued = (this.mutations.get(key) ?? Promise.resolve()).then(run, run)
    this.mutations.set(
      key,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    )
    return queued
  }

  /**
   * Force a synchronous-from-the-caller's-view refresh of a key. Used by tests
   * and by callers that need to guarantee they read the latest persisted state.
   */
  async reload<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): Promise<T> {
    const raw = await this.backend.load(key)
    this.cache.set(key, {
      value: raw ?? {},
      loadedAt: Date.now(),
      refreshing: false,
    })
    return merge(defaults, raw)
  }

  /** Drop the cached entry for a key (test helper). */
  invalidate(key: string): void {
    this.cache.delete(key)
  }

  private primeSync<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): T {
    if (this.backend instanceof FileAdminConfigBackend) {
      // File reads are synchronous; populate the cache immediately so the
      // first read already reflects persisted state.
      const raw = this.backend.loadSync(key)
      this.cache.set(key, { value: raw ?? {}, loadedAt: Date.now(), refreshing: false })
      return merge(defaults, raw)
    }

    // DB mode: we cannot block synchronously on the async load. Seed the cache
    // with defaults, return defaults for this first call, and load in the
    // background so the very next read (within the same TTL window) is correct.
    this.cache.set(key, { value: {}, loadedAt: 0, refreshing: false })
    this.refreshInBackground(key, defaults, merge)
    return merge(defaults, null)
  }

  private refreshInBackground<T extends object>(
    key: string,
    _defaults: T,
    _merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): void {
    const entry = this.cache.get(key)
    if (entry?.refreshing) return
    if (entry) entry.refreshing = true

    void this.backend
      .load(key)
      .then((raw) => {
        this.cache.set(key, {
          value: raw ?? {},
          loadedAt: Date.now(),
          refreshing: false,
        })
      })
      .catch((error: unknown) => {
        // Keep serving the last known value; clear the in-flight flag so a
        // later read can retry.
        const current = this.cache.get(key)
        if (current) current.refreshing = false
        logger.server.warn(`Background refresh of admin config "${key}" failed`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }
}

/** Shared singleton — single source of truth for all admin config. */
export const adminConfigStore = new AdminConfigStore()
