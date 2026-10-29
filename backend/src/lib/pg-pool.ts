// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readFileSync } from 'fs'
import { DatabaseError, Pool, type PoolConfig } from 'pg'
import { logger } from './logger'

let pool: Pool | null = null

/**
 * node-pg never attempts TLS by default, but RDS PG15+ enforces rds.force_ssl.
 * PGSSLROOTCERT: verified TLS (prod, RDS bundle in image); PGSSLMODE=no-verify: unverified; neither: none.
 */
function resolveSslConfig(): PoolConfig['ssl'] {
  const caPath = process.env.PGSSLROOTCERT
  if (caPath) {
    try {
      return { ca: readFileSync(caPath, 'utf-8'), rejectUnauthorized: true }
    } catch (error) {
      // Fail loudly: a missing bundle must not silently downgrade verified TLS to none.
      throw new Error(
        `PGSSLROOTCERT is set to "${caPath}" but could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  if (process.env.PGSSLMODE === 'no-verify') {
    logger.security.warn(
      'Postgres TLS is enabled but the server certificate is NOT verified (PGSSLMODE=no-verify). ' +
        'Set PGSSLROOTCERT to a CA bundle to verify it.',
    )
    return { rejectUnauthorized: false }
  }

  return undefined
}

/** DATABASE_URL, else built from PG* parts (as ECS injects them); null means use the file backend. */
export function resolveDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const host = process.env.PGHOST
  const user = process.env.PGUSER
  const password = process.env.PGPASSWORD
  const database = process.env.PGDATABASE
  if (!host || !user || !password || !database) return null

  const port = process.env.PGPORT || '5432'
  const enc = encodeURIComponent
  return `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(database)}`
}

/** Whether a Postgres backend is available (DATABASE_URL or PG* parts). */
export function hasDatabaseUrl(): boolean {
  return resolveDatabaseUrl() !== null
}

/** Throws without a database; gate on {@link hasDatabaseUrl}. */
export function getSharedPool(): Pool {
  if (pool) return pool
  const connectionString = resolveDatabaseUrl()
  if (!connectionString) {
    throw new Error('getSharedPool() called without a database configured')
  }
  // Explicit cap keeps the shared-Postgres connection budget deterministic.
  const ssl = resolveSslConfig()
  pool = new Pool({ connectionString, max: 10, ...(ssl ? { ssl } : {}) })
  logger.security.info('Postgres pool created', {
    tls: ssl ? (process.env.PGSSLROOTCERT ? 'verified' : 'unverified') : 'disabled',
  })
  return pool
}

/**
 * RDS only creates `keycloak` and init.sql runs only on fresh volumes, so the app database is created here.
 * Race-safe (42P04 = another task won) and never throws; the file backend covers failures.
 */
export async function ensureApplicationDatabase(): Promise<void> {
  const target = process.env.PGDATABASE
  const host = process.env.PGHOST
  const user = process.env.PGUSER
  const password = process.env.PGPASSWORD
  // DATABASE_URL callers manage their own database; only the PG* form names one we can create.
  if (!target || !host || !user || !password || process.env.DATABASE_URL) return

  // Connect via a database that always exists, since the target may not.
  const maintenance = process.env.PGMAINTENANCEDB || 'postgres'
  if (target === maintenance) return

  const ssl = resolveSslConfig()
  const port = process.env.PGPORT || '5432'
  const enc = encodeURIComponent
  const client = new Pool({
    connectionString: `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(maintenance)}`,
    max: 1,
    ...(ssl ? { ssl } : {}),
  })

  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])
    if (existing.rowCount === 0) {
      // CREATE DATABASE takes an identifier, not a bind parameter; quote it.
      await client.query(`CREATE DATABASE "${target.replace(/"/g, '""')}"`)
      logger.security.info('Created the application database', { database: target })
    }
  } catch (error) {
    if (error instanceof DatabaseError && error.code === '42P04') return // another task created it first
    logger.security.warn('Could not ensure the application database exists', {
      database: target,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await client.end().catch(() => {})
  }
}

/** Anything that runs a SQL string; a `pg` Pool or client does. */
interface SchemaClient {
  query(text: string): Promise<unknown>
}

const SCHEMA_LOCK_NAME = /^[a-z_][a-z0-9_]*$/

/**
 * Runs a store's DDL as one implicit transaction that holds an advisory lock, so nodes starting together
 * create it one after another instead of racing `CREATE ... IF NOT EXISTS` into duplicate_object errors.
 */
export async function createSchema(client: SchemaClient, name: string, statements: readonly string[]): Promise<void> {
  if (!SCHEMA_LOCK_NAME.test(name)) throw new Error(`Invalid schema name: ${name}`)
  const lock = `SELECT pg_advisory_xact_lock(hashtext('proxy-smart:schema:${name}'))`
  await client.query([lock, ...statements].map((statement) => statement.trim().replace(/;$/, '')).join(';\n'))
}
