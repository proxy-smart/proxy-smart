// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared PostgreSQL connection pool and connection-string resolution.
 *
 * A single process-wide `pg.Pool`, so every store that needs Postgres
 * (admin-config store today; mtls-store can adopt it later) shares one pool
 * instead of each opening its own. This avoids exhausting the RDS connection
 * budget under scale-out.
 *
 * Connection string resolution (single source of truth for all stores):
 *  1. `DATABASE_URL` if set (used by local dev and the beta docker-compose).
 *  2. Otherwise assembled from discrete `PG*` parts (`PGHOST`, `PGUSER`,
 *     `PGPASSWORD`, `PGDATABASE`, `PGPORT`). This mirrors how the Keycloak ECS
 *     task injects DB credentials as separate Secrets Manager secrets rather
 *     than embedding the password into a single concatenated string — so the
 *     password never appears in a plain task-definition env var.
 *
 * Lazily constructed on first use so importing this module has no side effects
 * when no database is configured.
 */

import { readFileSync } from 'fs'
import { DatabaseError, Pool, type PoolConfig } from 'pg'
import { logger } from './logger'

let pool: Pool | null = null

/**
 * TLS settings for the pool.
 *
 * THE BUG THIS FIXES. node-pg defaults to `ssl: false` — it never even attempts
 * TLS. RDS Postgres 15+ ships `rds.force_ssl = 1` by default, so every query from
 * production was rejected before it ran:
 *
 *   no pg_hba.conf entry for host "10.0.3.67", user "keycloak",
 *   database "proxy_smart", no encryption
 *
 * That took the FHIR proxy down entirely, because resolving a FHIR server reads
 * the admin-config store. Keycloak against the SAME instance was fine, which is
 * what made it confusing: the PostgreSQL JDBC driver defaults to
 * `sslmode=prefer`, so it negotiates TLS without being asked. node-pg does not.
 *
 * Configured explicitly here rather than through `?sslmode=` on the URL, because
 * pg 8.x maps `require` onto verify-full semantics and warns that pg 9 will change
 * that. An explicit object behaves the same across versions.
 *
 *   PGSSLROOTCERT  path to a CA bundle → verified TLS (what production uses; the
 *                  Amazon RDS bundle is baked into the image by Dockerfile)
 *   PGSSLMODE=no-verify  → encrypted but UNVERIFIED, for an environment with a
 *                  self-signed certificate. Warns, because it accepts any cert.
 *   neither        → no TLS, for local dev and the beta compose Postgres, which
 *                  is a container on a private network without force_ssl.
 */
function resolveSslConfig(): PoolConfig['ssl'] {
  const caPath = process.env.PGSSLROOTCERT
  if (caPath) {
    try {
      return { ca: readFileSync(caPath, 'utf-8'), rejectUnauthorized: true }
    } catch (error) {
      // Deliberately fail loudly rather than silently downgrading: a missing
      // bundle in production would otherwise turn verified TLS into no TLS, and
      // the resulting pg_hba rejection is far harder to read than this.
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

/**
 * Resolve the PostgreSQL connection string from the environment, or null when
 * no database is configured (callers then use the file/in-memory fallback).
 */
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

/**
 * Get the shared connection pool. Throws if no database is configured — callers
 * gate on {@link hasDatabaseUrl} first (the file backend is used otherwise).
 */
export function getSharedPool(): Pool {
  if (pool) return pool
  const connectionString = resolveDatabaseUrl()
  if (!connectionString) {
    throw new Error('getSharedPool() called without a database configured')
  }
  // Explicit cap (node-pg default is also 10) keeps the shared-Postgres
  // connection budget deterministic: the backend never opens more than this,
  // so it cannot contribute to "sorry, too many clients already" exhaustion.
  const ssl = resolveSslConfig()
  pool = new Pool({ connectionString, max: 10, ...(ssl ? { ssl } : {}) })
  logger.security.info('Postgres pool created', {
    tls: ssl ? (process.env.PGSSLROOTCERT ? 'verified' : 'unverified') : 'disabled',
  })
  return pool
}

/**
 * Create the application database if it is not there yet.
 *
 * WHY THIS EXISTS. RDS creates exactly the one database its `databaseName` names (`keycloak`), and
 * Postgres only runs `init.sql` on a FRESH data volume — so the backend's own database has to be
 * created by something, and on every environment so far that something was a human. Production ran
 * for months answering every FHIR request with 500 `database "proxy_smart" does not exist`, because
 * resolving a FHIR server reads the admin-config store, and the store is in here.
 *
 * Doing it at startup rather than in the deploy pipeline means a brand-new environment — the second
 * region, a fresh beta volume, a laptop — comes up complete without anyone remembering a step.
 *
 * Idempotent and safe to race: several tasks boot together, so `42P04` (duplicate_database) means
 * another task won and is a success, not an error. Never throws — an unreachable maintenance
 * database leaves the resilient file backend to cover it, exactly as before.
 */
export async function ensureApplicationDatabase(): Promise<void> {
  const target = process.env.PGDATABASE
  const host = process.env.PGHOST
  const user = process.env.PGUSER
  const password = process.env.PGPASSWORD
  // DATABASE_URL callers manage their own database; only the PG* form names one we can create.
  if (!target || !host || !user || !password || process.env.DATABASE_URL) return

  // `postgres` always exists and is never the target, so connecting here cannot be the thing that
  // fails when the target is missing.
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
      // Not parameterisable — CREATE DATABASE takes an identifier, not a value. `target` comes from
      // our own deployment config, and the quoting keeps a surprising name from becoming syntax.
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
