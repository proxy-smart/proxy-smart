// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { sha256 } from '../hash'
import { hasDatabaseUrl } from '../pg-pool'
import { TtlCache } from './ttl-cache'
import { OutageNotice, PgExpiringTable, type PgTableOptions } from './pg-expiring-table'

/** Where spent jtis are recorded for every node. Both calls are single atomic statements. */
export interface SharedJtiBackend {
  /** Records the key until `expiresAt`; false when an unexpired record already exists. */
  claim(key: string, expiresAt: number, now: number): Promise<boolean>
  isClaimed(key: string, now: number): Promise<boolean>
  dispose(): void
}

const TABLE = 'client_assertion_jti'

export class PostgresJtiBackend implements SharedJtiBackend {
  private readonly table: PgExpiringTable

  constructor(options: PgTableOptions = {}) {
    this.table = new PgExpiringTable({ ...options, name: TABLE, columns: 'jti_key TEXT PRIMARY KEY' })
  }

  /** An expired row that has not been purged yet is taken over, a live one is not. */
  async claim(key: string, expiresAt: number, now: number): Promise<boolean> {
    const result = await this.table.query(
      `INSERT INTO ${TABLE} (jti_key, expires_at) VALUES ($1, $2)
       ON CONFLICT (jti_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE ${TABLE}.expires_at <= $3`,
      [key, expiresAt, now],
    )
    return (result.rowCount ?? 0) > 0
  }

  async isClaimed(key: string, now: number): Promise<boolean> {
    const result = await this.table.query(`SELECT 1 FROM ${TABLE} WHERE jti_key = $1 AND expires_at > $2`, [key, now])
    return (result.rowCount ?? 0) > 0
  }

  purge(): Promise<number> {
    return this.table.purge()
  }

  dispose(): void {
    this.table.dispose()
  }
}

/** Bounded, unambiguous, and keeps client ids out of the table. */
function digest(issuer: string, jti: string): string {
  return sha256(JSON.stringify([issuer, jti]))
}

/**
 * The jtis of private_key_jwt assertions already used. Every node records locally first, so a
 * replay to the same node is refused even while the shared backend is unreachable; the shared
 * backend extends that to the whole deployment.
 */
export class JtiReplayCache {
  private readonly local = new TtlCache<true>({ ttlMs: 330_000, cleanupIntervalMs: 60_000 })
  private readonly shared: SharedJtiBackend | null
  private readonly outage = new OutageNotice('client assertion jti cache')

  constructor(options: { shared?: SharedJtiBackend | null } = {}) {
    this.shared = options.shared ?? null
  }

  async isSpent(issuer: string, jti: string): Promise<boolean> {
    const key = digest(issuer, jti)
    if (this.local.has(key)) return true
    if (!this.shared) return false
    try {
      const spent = await this.shared.isClaimed(key, Date.now())
      this.outage.recovered()
      return spent
    } catch (error) {
      this.outage.failed('lookup', error)
      return false
    }
  }

  /** True when this call spent the jti, false when it was already spent. `expiresAt` is epoch ms. */
  async spend(issuer: string, jti: string, expiresAt: number): Promise<boolean> {
    const key = digest(issuer, jti)
    const now = Date.now()
    if (this.local.has(key)) return false
    this.local.set(key, true, Math.max(1, expiresAt - now))
    if (!this.shared) return true
    try {
      const won = await this.shared.claim(key, expiresAt, now)
      this.outage.recovered()
      return won
    } catch (error) {
      this.outage.failed('spend', error)
      return true
    }
  }

  /** Forgets this node's record; shared rows expire on their own. */
  clear(): void {
    this.local.clear()
  }

  dispose(): void {
    this.local.dispose()
    this.shared?.dispose()
  }
}

export const jtiReplayCache = new JtiReplayCache({ shared: hasDatabaseUrl() ? new PostgresJtiBackend() : null })
