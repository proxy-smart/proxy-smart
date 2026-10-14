// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { TtlCache } from './cache/ttl-cache'
import { OutageNotice, PgExpiringTable, type PgTableOptions } from './cache/pg-expiring-table'
import { hasDatabaseUrl } from './pg-pool'

/** No access token outlives this, so neither does its revocation. */
const MAX_REMEMBERED_MS = 24 * 60 * 60 * 1000
const DEFAULT_SYNC_INTERVAL_MS = 5_000
const MAX_JTI_LENGTH = 128

export interface RevocationRow {
  id: number
  jti: string
  /** Epoch milliseconds */
  expiresAt: number
}

/** Revocations every node sees, ordered by an id the database assigns so node clocks never matter. */
export interface SharedRevocationBackend {
  add(jti: string, expiresAt: number): Promise<void>
  after(id: number, now: number): Promise<RevocationRow[]>
  dispose(): void
}

const TABLE = 'revoked_access_token'

export class PostgresRevocationBackend implements SharedRevocationBackend {
  private readonly table: PgExpiringTable

  constructor(options: PgTableOptions = {}) {
    this.table = new PgExpiringTable({ ...options, name: TABLE, columns: 'id BIGSERIAL PRIMARY KEY, jti TEXT NOT NULL' })
  }

  async add(jti: string, expiresAt: number): Promise<void> {
    await this.table.query(`INSERT INTO ${TABLE} (jti, expires_at) VALUES ($1, $2)`, [jti, expiresAt])
  }

  async after(id: number, now: number): Promise<RevocationRow[]> {
    const result = await this.table.query(
      `SELECT id, jti, expires_at FROM ${TABLE} WHERE id > $1 AND expires_at > $2 ORDER BY id`,
      [id, now],
    )
    return result.rows.flatMap((row) => {
      const rowId = Number(row.id)
      const expiresAt = Number(row.expires_at)
      return typeof row.jti === 'string' && Number.isFinite(rowId) && Number.isFinite(expiresAt)
        ? [{ id: rowId, jti: row.jti, expiresAt }]
        : []
    })
  }

  dispose(): void {
    this.table.dispose()
  }
}

/**
 * The jti of every access token revoked through this proxy, until it would have expired anyway.
 * Keycloak records the revocation for introspection; this lets the proxy's own JWT check honour
 * it. The check reads memory only; other nodes pick a revocation up on their next sync.
 */
export class RevokedTokenList {
  private readonly local = new TtlCache<true>({ ttlMs: MAX_REMEMBERED_MS, maxEntries: 100_000, cleanupIntervalMs: 5 * 60 * 1000 })
  private readonly shared: SharedRevocationBackend | null
  private readonly outage = new OutageNotice('revoked access tokens')
  private lastId = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: { shared?: SharedRevocationBackend | null; syncIntervalMs?: number } = {}) {
    this.shared = options.shared ?? null
    const interval = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    if (this.shared && interval > 0) {
      void this.sync()
      this.timer = setInterval(() => void this.sync(), interval)
      this.timer.unref?.()
    }
  }

  /** `exp` is the token's expiry in epoch seconds. */
  async revoke(jti: string, exp?: number): Promise<void> {
    if (jti.length === 0 || jti.length > MAX_JTI_LENGTH) return
    const now = Date.now()
    const expiresAt = Math.min(exp === undefined ? now + MAX_REMEMBERED_MS : exp * 1000, now + MAX_REMEMBERED_MS)
    if (expiresAt <= now) return
    this.local.set(jti, true, expiresAt - now)
    if (!this.shared) return
    try {
      await this.shared.add(jti, expiresAt)
      this.outage.recovered()
    } catch (error) {
      this.outage.failed('revoke', error)
    }
  }

  isRevoked(jti: unknown): boolean {
    return typeof jti === 'string' && this.local.has(jti)
  }

  async sync(): Promise<void> {
    if (!this.shared) return
    try {
      const now = Date.now()
      for (const row of await this.shared.after(this.lastId, now)) {
        this.lastId = Math.max(this.lastId, row.id)
        if (row.expiresAt > now) this.local.set(row.jti, true, Math.min(row.expiresAt - now, MAX_REMEMBERED_MS))
      }
      this.outage.recovered()
    } catch (error) {
      this.outage.failed('sync', error)
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.local.dispose()
    this.shared?.dispose()
  }
}

export const revokedTokens = new RevokedTokenList({ shared: hasDatabaseUrl() ? new PostgresRevocationBackend() : null })

export function markTokenRevoked(jti: string, exp?: number): Promise<void> {
  return revokedTokens.revoke(jti, exp)
}

export function isTokenRevoked(jti: unknown): boolean {
  return revokedTokens.isRevoked(jti)
}
