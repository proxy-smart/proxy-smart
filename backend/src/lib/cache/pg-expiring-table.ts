// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from '../logger'
import { getSharedPool } from '../pg-pool'

export interface SqlResult {
  rows: Array<Record<string, unknown>>
  rowCount: number | null
}

/** What the shared stores need from Postgres; a `pg` Pool satisfies it. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<SqlResult>
}

export interface PgTableOptions {
  /** Connection source, the shared pool by default. */
  client?: () => SqlClient
  /** How often expired rows are deleted. 0 leaves purging to the caller. */
  purgeIntervalMs?: number
}

export interface PgExpiringTableOptions extends PgTableOptions {
  /** A constant identifier, never user input. */
  name: string
  /** Column definitions; `expires_at` (epoch ms) is added. */
  columns: string
}

const DEFAULT_PURGE_INTERVAL_MS = 60_000

/** Codes Postgres raises when another node created the same table or index first. */
const ALREADY_CREATED = new Set(['42P07', '23505'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Logs the first failure of an outage and the recovery, not every failed call in between. */
export class OutageNotice {
  private down = false

  constructor(private readonly store: string) {}

  failed(operation: string, error: unknown): void {
    if (this.down) return
    this.down = true
    logger.security.warn(`${this.store}: shared Postgres store unavailable, serving this node's memory only`, {
      operation,
      error: message(error),
    })
  }

  recovered(): void {
    if (!this.down) return
    this.down = false
    logger.security.info(`${this.store}: shared Postgres store reachable again`)
  }
}

/** A table of rows that expire, created on first use and purged on a timer. */
export class PgExpiringTable {
  readonly name: string
  readonly outage: OutageNotice
  private ready: Promise<void> | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: PgExpiringTableOptions) {
    this.name = options.name
    this.outage = new OutageNotice(options.name)
    const interval = options.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS
    if (interval > 0) {
      this.purgeTimer = setInterval(() => {
        this.purge().catch((error: unknown) => this.outage.failed('purge', error))
      }, interval)
      this.purgeTimer.unref?.()
    }
  }

  async query(text: string, values: unknown[] = []): Promise<SqlResult> {
    await this.ensureCreated()
    return this.client().query(text, values)
  }

  /** Deletes expired rows and returns how many went. */
  async purge(now = Date.now()): Promise<number> {
    const result = await this.query(`DELETE FROM ${this.name} WHERE expires_at <= $1`, [now])
    return result.rowCount ?? 0
  }

  dispose(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    this.purgeTimer = null
  }

  private client(): SqlClient {
    return (this.options.client ?? getSharedPool)()
  }

  private ensureCreated(): Promise<void> {
    this.ready ??= this.create().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  private async create(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${this.name} (${this.options.columns}, expires_at BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${this.name}_expires_at_idx ON ${this.name} (expires_at)`,
    ]
    for (const statement of statements) {
      try {
        await this.client().query(statement)
      } catch (error) {
        const code = errorCode(error)
        if (!code || !ALREADY_CREATED.has(code)) throw error
      }
    }
  }
}
