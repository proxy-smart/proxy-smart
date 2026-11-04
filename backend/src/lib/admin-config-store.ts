// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Shared admin-config store: Postgres when DATABASE_URL is set (file fallback), else DATA_DIR files. Sync reads from a short-TTL cache. */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'
import { DATA_DIR } from './paths'
import { createSchema, getSharedPool, hasDatabaseUrl } from './pg-pool'
import { isRecord } from './type-guards'

/** Bounds how long a write on one task stays invisible to the others. */
const CACHE_TTL_MS = 5_000

const MUTATE_MAX_ATTEMPTS = 5

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

export interface VersionedAdminConfigValue {
  value: AdminConfigValue | null
  /** 0 when the key does not exist yet, so creating is just a compare-and-set from 0. */
  version: number
}

export interface AdminConfigBackend {
  load(key: string): Promise<AdminConfigValue | null>
  store(key: string, value: AdminConfigValue): Promise<void>
  /** Optional compare-and-set pair; without it {@link AdminConfigStore.mutate} serialises in-process only. */
  loadVersioned?(key: string): Promise<VersionedAdminConfigValue>
  /** False when another writer changed the revision since it was read. */
  storeIfVersion?(key: string, value: AdminConfigValue, expectedVersion: number): Promise<boolean>
}

/** Keys whose image-seeded file predates this store under another name; a file under the key itself wins. */
const LEGACY_FILE_STEMS = new Map([['app-store', 'app-store-config']])

class FileAdminConfigBackend implements AdminConfigBackend {
  private pathFor(key: string): string {
    const current = join(DATA_DIR, `${key}.json`)
    const legacy = LEGACY_FILE_STEMS.get(key)
    return legacy && !existsSync(current) ? join(DATA_DIR, `${legacy}.json`) : current
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
      logger.server.warn('Admin config file is not a JSON object, treating as unset', { path })
      return null
    } catch (error) {
      logger.server.warn('Failed to read admin config file, treating as unset', {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async store(key: string, value: AdminConfigValue): Promise<void> {
    writeFileSync(this.pathFor(key), JSON.stringify(value, null, 2), 'utf-8')
  }
}

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
    // pg returns BIGINT as a string.
    return {
      value: storedObject(key, result.rows[0].value),
      version: Number(result.rows[0].version),
    }
  }

  /** Version 0 means the row did not exist, so only an insert that wins the race counts. */
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

/** Tries the primary on every call and falls back to the file backend when it throws; warns once. */
export class ResilientAdminConfigBackend implements AdminConfigBackend {
  private fellBackOnce = false

  constructor(
    private readonly primary: AdminConfigBackend,
    private readonly fallback: AdminConfigBackend,
  ) {}

  /** Sticky: true once the primary has failed at least once in this process. */
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

interface CacheEntry {
  value: AdminConfigValue
  loadedAt: number
  refreshing: boolean
}

export class AdminConfigStore {
  private readonly backend: AdminConfigBackend
  private readonly cache = new Map<string, CacheEntry>()
  private readonly mutations = new Map<string, Promise<void>>()
  readonly durable: boolean

  /** @param backend explicit backend for tests; omitted, it is chosen from DATABASE_URL. */
  constructor(backend?: AdminConfigBackend) {
    if (backend) {
      this.backend = backend
      this.durable = backend instanceof PostgresAdminConfigBackend
      return
    }

    if (hasDatabaseUrl()) {
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

  /** False once any operation in this process has fallen back to a task-local file. */
  get persistsDurably(): boolean {
    if (this.backend instanceof ResilientAdminConfigBackend) return this.durable && !this.backend.usingFallback
    return this.durable
  }

  static withResilientBackend(primary: AdminConfigBackend): AdminConfigStore {
    return new AdminConfigStore(
      new ResilientAdminConfigBackend(primary, new FileAdminConfigBackend()),
    )
  }

  /** Sync read from the cache; a stale entry refreshes in the background and is still returned. */
  get<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): T {
    const entry = this.cache.get(key)
    if (!entry) return this.primeSync(key, defaults, merge)

    if (Date.now() - entry.loadedAt > CACHE_TTL_MS) this.refreshInBackground(key)
    return merge(defaults, entry.value)
  }

  /** Last-writer-wins; the cache updates before the returned write settles. */
  async set<T extends object>(key: string, value: T): Promise<void> {
    const serialisable = toConfigValue(value)
    this.cache.set(key, { value: serialisable, loadedAt: Date.now(), refreshing: false })
    await this.backend.store(key, serialisable)
  }

  /** Read-modify-write via compare-and-set with retries; same-task calls queue per key. */
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
        logger.debug('security', 'admin config mutation retrying after a concurrent write', { key, attempt })
      }

      throw new Error(`Could not update admin config '${key}': too many concurrent writers`)
    }

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

  /** Read straight from the backend and replace the cached entry. */
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

  invalidate(key: string): void {
    this.cache.delete(key)
  }

  private primeSync<T extends object>(
    key: string,
    defaults: T,
    merge: (defaults: T, raw: AdminConfigValue | null) => T,
  ): T {
    if (this.backend instanceof FileAdminConfigBackend) {
      const raw = this.backend.loadSync(key)
      this.cache.set(key, { value: raw ?? {}, loadedAt: Date.now(), refreshing: false })
      return merge(defaults, raw)
    }

    // An async backend cannot answer synchronously: serve defaults while the first load runs.
    this.cache.set(key, { value: {}, loadedAt: 0, refreshing: false })
    this.refreshInBackground(key)
    return merge(defaults, null)
  }

  private refreshInBackground(key: string): void {
    const entry = this.cache.get(key)
    if (entry?.refreshing) return
    if (entry) entry.refreshing = true

    void this.backend
      .load(key)
      .then((raw) => {
        // A write or reload since this load began replaced the entry and is newer than `raw`.
        if (this.cache.get(key) !== entry) return
        this.cache.set(key, {
          value: raw ?? {},
          loadedAt: Date.now(),
          refreshing: false,
        })
      })
      .catch((error: unknown) => {
        const current = this.cache.get(key)
        if (current) current.refreshing = false
        logger.server.warn(`Background refresh of admin config "${key}" failed`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }
}

export const adminConfigStore = new AdminConfigStore()
