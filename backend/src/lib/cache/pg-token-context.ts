// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { SharedTokenContextBackend, StoredTokenContext, TokenContext } from '../token-context-store'
import { PgExpiringTable, type PgTableOptions } from './pg-expiring-table'

const TABLE = 'smart_token_context'

/** Launch contexts by jti in Postgres, so every node can answer for every token. */
export class PostgresTokenContextBackend implements SharedTokenContextBackend {
  private readonly table: PgExpiringTable

  constructor(options: PgTableOptions = {}) {
    this.table = new PgExpiringTable({ ...options, name: TABLE, columns: 'jti TEXT PRIMARY KEY, context JSONB NOT NULL' })
  }

  async put(jti: string, context: TokenContext, expiresAt: number): Promise<void> {
    await this.table.query(
      `INSERT INTO ${TABLE} (jti, context, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (jti) DO UPDATE SET context = EXCLUDED.context, expires_at = EXCLUDED.expires_at`,
      [jti, JSON.stringify(context), expiresAt],
    )
  }

  async fetch(jti: string, now: number): Promise<StoredTokenContext | null> {
    const result = await this.table.query(`SELECT context, expires_at FROM ${TABLE} WHERE jti = $1 AND expires_at > $2`, [jti, now])
    const row = result.rows[0]
    if (!row) return null
    return { context: row.context, expiresAt: Number(row.expires_at) }
  }

  async remove(jti: string): Promise<void> {
    await this.table.query(`DELETE FROM ${TABLE} WHERE jti = $1`, [jti])
  }

  purge(): Promise<number> {
    return this.table.purge()
  }

  dispose(): void {
    this.table.dispose()
  }
}
