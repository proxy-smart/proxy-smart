// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { sha256 } from '../hash'
import { config } from '../../config'
import { hasDatabaseUrl } from '../pg-pool'
import { TtlCache } from './ttl-cache'
import { OutageNotice, PgExpiringTable, type PgTableOptions } from './pg-expiring-table'

export interface PageCursorGrant {
  owner: string
  server: string
  screenReads: boolean
}

export interface SharedPageCursorBackend {
  save(cursor: string, grant: PageCursorGrant, expiresAt: number): Promise<void>
  find(cursor: string, now: number): Promise<PageCursorGrant | null>
  dispose(): void
}

const TABLE = 'fhir_page_cursor'

export class PostgresPageCursorBackend implements SharedPageCursorBackend {
  private readonly table: PgExpiringTable

  constructor(options: PgTableOptions = {}) {
    this.table = new PgExpiringTable({
      ...options,
      name: TABLE,
      columns: 'cursor_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, server_name TEXT NOT NULL, screen_reads BOOLEAN NOT NULL',
    })
  }

  async save(cursor: string, grant: PageCursorGrant, expiresAt: number): Promise<void> {
    await this.table.query(
      `INSERT INTO ${TABLE} (cursor_key, owner_key, server_name, screen_reads, expires_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cursor_key) DO UPDATE SET owner_key = EXCLUDED.owner_key, server_name = EXCLUDED.server_name,
         screen_reads = EXCLUDED.screen_reads, expires_at = EXCLUDED.expires_at`,
      [cursor, grant.owner, grant.server, grant.screenReads, expiresAt],
    )
  }

  async find(cursor: string, now: number): Promise<PageCursorGrant | null> {
    const result = await this.table.query(
      `SELECT owner_key, server_name, screen_reads FROM ${TABLE} WHERE cursor_key = $1 AND expires_at > $2`,
      [cursor, now],
    )
    const row = result.rows[0]
    if (!row) return null
    const { owner_key: owner, server_name: server, screen_reads: screenReads } = row
    if (typeof owner !== 'string' || typeof server !== 'string' || typeof screenReads !== 'boolean') return null
    return { owner, server, screenReads }
  }

  dispose(): void {
    this.table.dispose()
  }
}

export function pageCursorOwner(tokenPayload: Record<string, unknown>): string {
  const client = typeof tokenPayload.azp === 'string' ? tokenPayload.azp : typeof tokenPayload.client_id === 'string' ? tokenPayload.client_id : ''
  const subject = typeof tokenPayload.sub === 'string' ? tokenPayload.sub : ''
  return sha256(`${client}\u0000${subject}`)
}

export class PageCursorCache {
  private readonly local: TtlCache<PageCursorGrant>
  private readonly shared: SharedPageCursorBackend | null
  private readonly outage = new OutageNotice('FHIR page cursor cache')

  constructor(options: { shared?: SharedPageCursorBackend | null; ttlMs?: number; maxEntries?: number } = {}) {
    this.shared = options.shared ?? null
    this.local = new TtlCache({ ttlMs: options.ttlMs ?? config.fhir.pagingCursorTtlMs, maxEntries: options.maxEntries ?? 50_000, cleanupIntervalMs: 60_000 })
  }

  async remember(cursors: Iterable<string>, grant: PageCursorGrant): Promise<void> {
    const ttlMs = config.fhir.pagingCursorTtlMs
    const expiresAt = Date.now() + ttlMs
    for (const cursor of cursors) {
      const key = sha256(cursor)
      this.local.set(key, grant, ttlMs)
      if (!this.shared) continue
      try {
        await this.shared.save(key, grant, expiresAt)
        this.outage.recovered()
      } catch (error) {
        this.outage.failed('save', error)
      }
    }
  }

  async grantFor(cursor: string): Promise<PageCursorGrant | null> {
    const key = sha256(cursor)
    const local = this.local.get(key)
    if (local) return local
    if (!this.shared) return null
    try {
      const found = await this.shared.find(key, Date.now())
      this.outage.recovered()
      if (found) this.local.set(key, found)
      return found
    } catch (error) {
      this.outage.failed('lookup', error)
      return null
    }
  }

  clear(): void {
    this.local.clear()
  }

  dispose(): void {
    this.local.dispose()
    this.shared?.dispose()
  }
}

export const pageCursorCache = new PageCursorCache({ shared: hasDatabaseUrl() ? new PostgresPageCursorBackend() : null })
