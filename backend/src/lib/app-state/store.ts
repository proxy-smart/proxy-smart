// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Value } from '@sinclair/typebox/value'
import { AppStateBasic, type AppStateBasicType } from '@/schemas/app-state'
import { logger } from '../logger'
import { DATA_DIR, ensureDataDir } from '../paths'
import type { Pool, QueryResultRow } from 'pg'
import { createSchema, getSharedPool, hasDatabaseUrl } from '../pg-pool'

export interface AppStateRecord {
  id: string
  version: number
  stateCode: string
  subject: string | null
  clientId: string
  resource: AppStateBasicType
}

export interface AppStateQuery {
  stateCode: string
  subject: string | null
}

export interface AppStateBackend {
  insert(record: AppStateRecord, maxPerSubject: number): Promise<boolean>
  get(id: string): Promise<AppStateRecord | null>
  replace(record: AppStateRecord, expectedVersion: number): Promise<boolean>
  remove(id: string, expectedVersion: number): Promise<boolean>
  search(query: AppStateQuery): Promise<AppStateRecord[]>
}

const matches = (record: AppStateRecord, query: AppStateQuery) =>
  record.stateCode === query.stateCode && record.subject === query.subject

export class MemoryAppStateBackend implements AppStateBackend {
  protected readonly records = new Map<string, AppStateRecord>()

  protected changed(): void {}

  async insert(record: AppStateRecord, maxPerSubject: number): Promise<boolean> {
    if (this.records.has(record.id)) throw new Error(`App State ${record.id} already exists`)
    const held = [...this.records.values()].filter((existing) => matches(existing, record)).length
    if (held >= maxPerSubject) return false
    this.records.set(record.id, structuredClone(record))
    this.changed()
    return true
  }

  async get(id: string): Promise<AppStateRecord | null> {
    const record = this.records.get(id)
    return record ? structuredClone(record) : null
  }

  async replace(record: AppStateRecord, expectedVersion: number): Promise<boolean> {
    if (this.records.get(record.id)?.version !== expectedVersion) return false
    this.records.set(record.id, structuredClone(record))
    this.changed()
    return true
  }

  async remove(id: string, expectedVersion: number): Promise<boolean> {
    if (this.records.get(id)?.version !== expectedVersion) return false
    this.records.delete(id)
    this.changed()
    return true
  }

  async search(query: AppStateQuery): Promise<AppStateRecord[]> {
    return [...this.records.values()].filter((record) => matches(record, query)).map((record) => structuredClone(record))
  }
}

function isAppStateRecord(value: unknown): value is AppStateRecord {
  if (typeof value !== 'object' || value === null) return false
  const { id, version, stateCode, subject, clientId, resource } = Object.fromEntries(Object.entries(value))
  return typeof id === 'string' && typeof version === 'number' && typeof stateCode === 'string'
    && (subject === null || typeof subject === 'string') && typeof clientId === 'string'
    && Value.Check(AppStateBasic, resource)
}

export class FileAppStateBackend extends MemoryAppStateBackend {
  constructor(private readonly path: string) {
    super()
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      for (const record of Array.isArray(parsed) ? parsed.filter(isAppStateRecord) : []) this.records.set(record.id, record)
    } catch (error) {
      logger.fhir.error('Could not read the App State file; starting empty', {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  protected override changed(): void {
    writeFileSync(this.path, JSON.stringify([...this.records.values()]), 'utf-8')
  }
}

const COLUMNS = 'id, version, state_code, subject, client_id, resource'

interface AppStateRow extends QueryResultRow {
  id: string
  version: string
  state_code: string
  subject: string | null
  client_id: string
  resource: unknown
}

function fromRow(row: AppStateRow): AppStateRecord | null {
  const record = {
    id: row.id,
    version: Number(row.version),
    stateCode: row.state_code,
    subject: row.subject,
    clientId: row.client_id,
    resource: row.resource,
  }
  return isAppStateRecord(record) ? record : null
}

export interface PostgresAppStateOptions {
  table?: string
  pool?: () => Pool
}

export class PostgresAppStateBackend implements AppStateBackend {
  private ready: Promise<void> | null = null
  private readonly table: string
  private readonly pool: () => Pool

  constructor(options: PostgresAppStateOptions = {}) {
    this.table = options.table ?? 'smart_app_state'
    this.pool = options.pool ?? getSharedPool
    if (!/^[a-z_][a-z0-9_]*$/.test(this.table)) throw new Error(`Invalid App State table name: ${this.table}`)
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      await createSchema(this.pool(), this.table, [
        `CREATE TABLE IF NOT EXISTS ${this.table} (
          id TEXT PRIMARY KEY,
          version BIGINT NOT NULL,
          state_code TEXT NOT NULL,
          subject TEXT,
          client_id TEXT NOT NULL,
          resource JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS ${this.table}_lookup ON ${this.table} (state_code, subject)`,
      ])
    })().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  private async rows(sql: string, params: unknown[]): Promise<AppStateRow[]> {
    await this.initialize()
    const result = await this.pool().query<AppStateRow>(sql, params)
    return result.rows
  }

  private async changes(sql: string, params: unknown[]): Promise<number> {
    await this.initialize()
    return (await this.pool().query(sql, params)).rowCount ?? 0
  }

  private where(query: AppStateQuery): { clause: string; params: unknown[] } {
    return query.subject === null
      ? { clause: 'state_code = $1 AND subject IS NULL', params: [query.stateCode] }
      : { clause: 'state_code = $1 AND subject = $2', params: [query.stateCode, query.subject] }
  }

  // The advisory lock serialises inserts per (code, subject); the INSERT runs after it, so its count sees every committed row.
  async insert(record: AppStateRecord, maxPerSubject: number): Promise<boolean> {
    await this.initialize()
    const client = await this.pool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${this.table}|${record.stateCode}|${record.subject ?? ''}`])
      const result = await client.query(
        `INSERT INTO ${this.table} (${COLUMNS})
         SELECT $1::text, $2::bigint, $3::text, $4::text, $5::text, $6::jsonb
         WHERE (SELECT COUNT(*) FROM ${this.table} WHERE state_code = $3::text AND subject IS NOT DISTINCT FROM $4::text) < $7::bigint`,
        [record.id, record.version, record.stateCode, record.subject, record.clientId, JSON.stringify(record.resource), maxPerSubject],
      )
      await client.query('COMMIT')
      return (result.rowCount ?? 0) > 0
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async get(id: string): Promise<AppStateRecord | null> {
    const [row] = await this.rows(`SELECT ${COLUMNS} FROM ${this.table} WHERE id = $1`, [id])
    return row ? fromRow(row) : null
  }

  async replace(record: AppStateRecord, expectedVersion: number): Promise<boolean> {
    const changed = await this.changes(
      `UPDATE ${this.table} SET version = $2, resource = $3, updated_at = NOW() WHERE id = $1 AND version = $4`,
      [record.id, record.version, JSON.stringify(record.resource), expectedVersion],
    )
    return changed > 0
  }

  async remove(id: string, expectedVersion: number): Promise<boolean> {
    return (await this.changes(`DELETE FROM ${this.table} WHERE id = $1 AND version = $2`, [id, expectedVersion])) > 0
  }

  async search(query: AppStateQuery): Promise<AppStateRecord[]> {
    const { clause, params } = this.where(query)
    const rows = await this.rows(`SELECT ${COLUMNS} FROM ${this.table} WHERE ${clause} ORDER BY updated_at, id`, params)
    return rows.map(fromRow).filter((record): record is AppStateRecord => record !== null)
  }
}

export function createAppStateBackend(): AppStateBackend {
  if (hasDatabaseUrl()) return new PostgresAppStateBackend()
  ensureDataDir()
  return new FileAppStateBackend(join(DATA_DIR, 'app-state.json'))
}
