// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Value } from '@sinclair/typebox/value'
import { AppStateBasic, type AppStateBasicType } from '@/schemas/app-state'
import { logger } from '../logger'
import { DATA_DIR, ensureDataDir } from '../paths'
import type { QueryResultRow } from 'pg'
import { getSharedPool, hasDatabaseUrl } from '../pg-pool'

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
  insert(record: AppStateRecord): Promise<void>
  get(id: string): Promise<AppStateRecord | null>
  replace(record: AppStateRecord, expectedVersion: number): Promise<boolean>
  remove(id: string, expectedVersion: number): Promise<boolean>
  search(query: AppStateQuery): Promise<AppStateRecord[]>
  count(query: AppStateQuery): Promise<number>
}

const matches = (record: AppStateRecord, query: AppStateQuery) =>
  record.stateCode === query.stateCode && record.subject === query.subject

export class MemoryAppStateBackend implements AppStateBackend {
  protected readonly records = new Map<string, AppStateRecord>()

  protected changed(): void {}

  async insert(record: AppStateRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`App State ${record.id} already exists`)
    this.records.set(record.id, structuredClone(record))
    this.changed()
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

  async count(query: AppStateQuery): Promise<number> {
    return [...this.records.values()].filter((record) => matches(record, query)).length
  }
}

function isRecord(value: unknown): value is AppStateRecord {
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
      for (const record of Array.isArray(parsed) ? parsed.filter(isRecord) : []) this.records.set(record.id, record)
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
  return isRecord(record) ? record : null
}

export class PostgresAppStateBackend implements AppStateBackend {
  private ready: Promise<void> | null = null

  constructor(private readonly table = 'smart_app_state') {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid App State table name: ${table}`)
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      const pool = getSharedPool()
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id TEXT PRIMARY KEY,
          version BIGINT NOT NULL,
          state_code TEXT NOT NULL,
          subject TEXT,
          client_id TEXT NOT NULL,
          resource JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `)
      await pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_lookup ON ${this.table} (state_code, subject)`)
    })().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  private async rows<T extends QueryResultRow = AppStateRow>(sql: string, params: unknown[]): Promise<T[]> {
    await this.initialize()
    const result = await getSharedPool().query<T>(sql, params)
    return result.rows
  }

  private async changes(sql: string, params: unknown[]): Promise<number> {
    await this.initialize()
    return (await getSharedPool().query(sql, params)).rowCount ?? 0
  }

  private where(query: AppStateQuery): { clause: string; params: unknown[] } {
    return query.subject === null
      ? { clause: 'state_code = $1 AND subject IS NULL', params: [query.stateCode] }
      : { clause: 'state_code = $1 AND subject = $2', params: [query.stateCode, query.subject] }
  }

  async insert(record: AppStateRecord): Promise<void> {
    await this.changes(
      `INSERT INTO ${this.table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.id, record.version, record.stateCode, record.subject, record.clientId, JSON.stringify(record.resource)],
    )
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

  async count(query: AppStateQuery): Promise<number> {
    const { clause, params } = this.where(query)
    const [row] = await this.rows<{ total: string }>(`SELECT COUNT(*) AS total FROM ${this.table} WHERE ${clause}`, params)
    return row ? Number(row.total) : 0
  }
}

export function createAppStateBackend(): AppStateBackend {
  if (hasDatabaseUrl()) return new PostgresAppStateBackend()
  ensureDataDir()
  return new FileAppStateBackend(join(DATA_DIR, 'app-state.json'))
}
