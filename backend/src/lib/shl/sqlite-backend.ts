// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { logger } from '../logger'
import { SHL_ROW_COLUMNS, type ShlLookupColumn, type ShlRow, type ShlSessionBackend } from './session'

const CountRow = Type.Object({ cnt: Type.Number() })

const LATER_COLUMNS = [
  'study_instance_uid TEXT',
  'share_scope TEXT',
  'consent_mirrored INTEGER NOT NULL DEFAULT 0',
  'write_scope TEXT',
  'recipient_name TEXT',
  'attestation TEXT',
]

function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run(`
    CREATE TABLE IF NOT EXISTS shl_sessions (
      id TEXT PRIMARY KEY,
      session_token TEXT NOT NULL UNIQUE,
      shl_payload TEXT NOT NULL,
      jwe TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      study_instance_uid TEXT,
      fhir_server_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      verified_only INTEGER NOT NULL DEFAULT 0,
      share_scope TEXT,
      write_scope TEXT,
      recipient_name TEXT,
      attestation TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      passcode_hash TEXT,
      consent_mirrored INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `)
  for (const column of LATER_COLUMNS) {
    try {
      db.run(`ALTER TABLE shl_sessions ADD COLUMN ${column}`)
    } catch {
      /* column already exists */
    }
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_shl_expires_at ON shl_sessions(expires_at)')
  db.run(`
    CREATE TABLE IF NOT EXISTS shl_accesses (
      shl_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (shl_id, fingerprint)
    )
  `)
  return db
}

/** SHL sessions in a local SQLite file: durable only where that file sits on a persistent volume. */
export class SqliteShlBackend implements ShlSessionBackend {
  private readonly db: Database
  private readonly purgeTimer: ReturnType<typeof setInterval> | null = null

  constructor(path: string, options: { purgeIntervalMs?: number } = {}) {
    this.db = open(path)
    this.purgeExpired()
    const interval = options.purgeIntervalMs ?? 60_000
    if (interval > 0) {
      this.purgeTimer = setInterval(() => this.purgeExpired(), interval)
      this.purgeTimer.unref()
    }
  }

  async put(row: ShlRow): Promise<void> {
    const placeholders = SHL_ROW_COLUMNS.map(() => '?').join(', ')
    this.db
      .query(`INSERT OR REPLACE INTO shl_sessions (${SHL_ROW_COLUMNS.join(', ')}) VALUES (${placeholders})`)
      .run(...SHL_ROW_COLUMNS.map((column) => row[column]))
  }

  async find(column: ShlLookupColumn, value: string): Promise<unknown> {
    return this.db.query(`SELECT * FROM shl_sessions WHERE ${column} = ?`).get(value)
  }

  async remove(id: string): Promise<void> {
    this.db.query('DELETE FROM shl_sessions WHERE id = ?').run(id)
    this.db.query('DELETE FROM shl_accesses WHERE shl_id = ?').run(id)
  }

  async incrementAccessCount(id: string): Promise<void> {
    this.db.query('UPDATE shl_sessions SET access_count = access_count + 1 WHERE id = ?').run(id)
  }

  async recordAccess(id: string, fingerprint: string, now: number): Promise<void> {
    this.db
      .query(`
        INSERT INTO shl_accesses (shl_id, fingerprint, first_seen, last_seen, count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(shl_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1
      `)
      .run(id, fingerprint, now, now)
  }

  async distinctDevices(id: string): Promise<number> {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM shl_accesses WHERE shl_id = ?').get(id)
    return Value.Check(CountRow, row) ? row.cnt : 0
  }

  async recordAttestation(id: string, attestation: string): Promise<boolean> {
    return this.db.query('UPDATE shl_sessions SET attestation = ? WHERE id = ? AND attestation IS NULL').run(attestation, id).changes > 0
  }

  async markConsentMirrored(id: string): Promise<void> {
    this.db.query('UPDATE shl_sessions SET consent_mirrored = 1 WHERE id = ?').run(id)
  }

  async listUnmirrored(now: number, limit: number): Promise<unknown[]> {
    return this.db
      .query('SELECT * FROM shl_sessions WHERE consent_mirrored = 0 AND expires_at >= ? ORDER BY created_at LIMIT ?')
      .all(now, limit)
  }

  /** Every unexpired session and its access rows, for a move to another backend. */
  exportActive(now: number): { sessions: unknown[]; accesses: unknown[] } {
    return {
      sessions: this.db.query('SELECT * FROM shl_sessions WHERE expires_at >= ?').all(now),
      accesses: this.db
        .query('SELECT a.* FROM shl_accesses a JOIN shl_sessions s ON s.id = a.shl_id WHERE s.expires_at >= ?')
        .all(now),
    }
  }

  dispose(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    this.db.close()
  }

  private purgeExpired(): void {
    const result = this.db.query('DELETE FROM shl_sessions WHERE expires_at < ?').run(Date.now())
    this.db.query('DELETE FROM shl_accesses WHERE shl_id NOT IN (SELECT id FROM shl_sessions)').run()
    if (result.changes > 0) logger.auth.debug('SHL store: purged expired sessions', { count: result.changes })
  }
}
