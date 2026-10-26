// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { PgExpiringTable, type PgTableOptions } from '../cache/pg-expiring-table'
import { SHL_ROW_COLUMNS, type ShlAccessRow, type ShlLookupColumn, type ShlRow, type ShlSessionBackend } from './session'

const SESSIONS = 'shl_sessions'
const ACCESSES = 'shl_accesses'

const SESSION_COLUMNS = `
  id TEXT PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  shl_payload TEXT NOT NULL,
  jwe TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  study_instance_uid TEXT,
  fhir_server_url TEXT NOT NULL,
  verified_only INTEGER NOT NULL DEFAULT 0,
  share_scope TEXT,
  write_scope TEXT,
  recipient_name TEXT,
  attestation TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  passcode_hash TEXT,
  consent_mirrored INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL`

const ACCESS_COLUMNS = `
  shl_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shl_id, fingerprint)`

/** node-pg returns BIGINT as a string; these read back as numbers like every other backend's. */
const BIGINT_COLUMNS = new Set<string>(['expires_at', 'created_at'])
const SELECT_LIST = SHL_ROW_COLUMNS.map((column) => (BIGINT_COLUMNS.has(column) ? `${column}::float8 AS ${column}` : column)).join(', ')
const INSERT_COLUMNS = SHL_ROW_COLUMNS.join(', ')
const INSERT_VALUES = SHL_ROW_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')
const UPSERT_SET = SHL_ROW_COLUMNS.filter((column) => column !== 'id').map((column) => `${column} = EXCLUDED.${column}`).join(', ')

/** SHL sessions in the shared Postgres, so links outlive the task that minted them and work on every node. */
export class PostgresShlBackend implements ShlSessionBackend {
  private readonly sessions: PgExpiringTable
  private readonly accesses: PgExpiringTable

  constructor(options: PgTableOptions = {}) {
    this.sessions = new PgExpiringTable({ ...options, name: SESSIONS, columns: SESSION_COLUMNS })
    this.accesses = new PgExpiringTable({ ...options, name: ACCESSES, columns: ACCESS_COLUMNS })
  }

  async put(row: ShlRow): Promise<void> {
    await this.sessions.query(
      `INSERT INTO ${SESSIONS} (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES}) ON CONFLICT (id) DO UPDATE SET ${UPSERT_SET}`,
      SHL_ROW_COLUMNS.map((column) => row[column]),
    )
  }

  async find(column: ShlLookupColumn, value: string): Promise<unknown> {
    const result = await this.sessions.query(`SELECT ${SELECT_LIST} FROM ${SESSIONS} WHERE ${column} = $1`, [value])
    return result.rows[0]
  }

  async remove(id: string): Promise<void> {
    await this.sessions.query(`DELETE FROM ${SESSIONS} WHERE id = $1`, [id])
    await this.accesses.query(`DELETE FROM ${ACCESSES} WHERE shl_id = $1`, [id])
  }

  async incrementAccessCount(id: string): Promise<void> {
    await this.sessions.query(`UPDATE ${SESSIONS} SET access_count = access_count + 1 WHERE id = $1`, [id])
  }

  /** An access row expires with its session, so both tables purge on their own timers. */
  async recordAccess(id: string, fingerprint: string, now: number): Promise<void> {
    await this.sessions.ensureCreated()
    await this.accesses.query(
      `INSERT INTO ${ACCESSES} (shl_id, fingerprint, first_seen, last_seen, count, expires_at)
       SELECT id, $2, $3, $3, 1, expires_at FROM ${SESSIONS} WHERE id = $1
       ON CONFLICT (shl_id, fingerprint) DO UPDATE SET last_seen = EXCLUDED.last_seen, count = ${ACCESSES}.count + 1`,
      [id, fingerprint, now],
    )
  }

  async distinctDevices(id: string): Promise<number> {
    const result = await this.accesses.query(`SELECT COUNT(*)::int AS cnt FROM ${ACCESSES} WHERE shl_id = $1`, [id])
    return Number(result.rows[0]?.cnt ?? 0)
  }

  async recordAttestation(id: string, attestation: string): Promise<boolean> {
    const result = await this.sessions.query(`UPDATE ${SESSIONS} SET attestation = $1 WHERE id = $2 AND attestation IS NULL`, [attestation, id])
    return (result.rowCount ?? 0) > 0
  }

  async markConsentMirrored(id: string): Promise<void> {
    await this.sessions.query(`UPDATE ${SESSIONS} SET consent_mirrored = 1 WHERE id = $1`, [id])
  }

  async listUnmirrored(now: number, limit: number): Promise<unknown[]> {
    const result = await this.sessions.query(
      `SELECT ${SELECT_LIST} FROM ${SESSIONS} WHERE consent_mirrored = 0 AND expires_at >= $1 ORDER BY created_at LIMIT $2`,
      [now, limit],
    )
    return result.rows
  }

  /** Copies sessions in, keeping any already here; returns how many were new. */
  async importSessions(sessions: readonly ShlRow[], accesses: readonly ShlAccessRow[]): Promise<number> {
    let imported = 0
    for (const row of sessions) {
      const result = await this.sessions.query(
        `INSERT INTO ${SESSIONS} (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES}) ON CONFLICT DO NOTHING`,
        SHL_ROW_COLUMNS.map((column) => row[column]),
      )
      imported += result.rowCount ?? 0
    }
    const expiry = new Map(sessions.map((row) => [row.id, row.expires_at]))
    for (const access of accesses) {
      const expiresAt = expiry.get(access.shl_id)
      if (expiresAt === undefined) continue
      await this.accesses.query(
        `INSERT INTO ${ACCESSES} (shl_id, fingerprint, first_seen, last_seen, count, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [access.shl_id, access.fingerprint, access.first_seen, access.last_seen, access.count, expiresAt],
      )
    }
    return imported
  }

  async purge(now = Date.now()): Promise<number> {
    const [sessions] = await Promise.all([this.sessions.purge(now), this.accesses.purge(now)])
    return sessions
  }

  dispose(): void {
    this.sessions.dispose()
    this.accesses.dispose()
  }
}
