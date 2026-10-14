// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Creating the application database at startup.
 *
 * THE OUTAGE THIS PREVENTS. RDS creates only the database its `databaseName` names, and Postgres
 * runs init.sql only on a fresh volume — so nothing created `proxy_smart`, and production answered
 * every FHIR request with 500 `database "proxy_smart" does not exist` for months, because resolving
 * a FHIR server reads the admin-config store that lives in it.
 *
 * What is worth pinning is not the happy path but the three ways this could make things worse:
 * throwing on a database that is merely unreachable, treating a lost race as a failure, and
 * connecting to the very database it is trying to create.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { DatabaseError } from 'pg'

const RealDatabaseError = DatabaseError

const ORIGINAL = { ...process.env }

/** Records what was connected to and asked, so assertions are about behaviour not internals. */
interface Recorded { connectionString?: string; queries: string[] }

let recorded: Recorded
let queryImpl: (sql: string) => Promise<{ rowCount: number }>

/*
 * Stand in for `pg`, mocked BEFORE the module under test is imported — `mock.module` only affects
 * later imports, so hoisting it is what makes the interception work. Mocked rather than injected so
 * the function keeps its zero-argument signature: startup callers should not have to know it talks
 * to Postgres.
 */
mock.module('pg', () => ({
  DatabaseError: RealDatabaseError,
  Pool: class {
    constructor(config: { connectionString?: string }) {
      recorded.connectionString = config.connectionString
    }
    async query(sql: string) {
      recorded.queries.push(sql)
      return queryImpl(sql)
    }
    async end() {}
  },
}))

const { ensureApplicationDatabase } = await import('../src/lib/pg-pool')

beforeEach(() => {
  recorded = { queries: [] }
  queryImpl = async () => ({ rowCount: 0 })
  process.env.PGHOST = 'db.example.com'
  process.env.PGUSER = 'keycloak'
  process.env.PGPASSWORD = 'secret'
  process.env.PGDATABASE = 'proxy_smart'
  delete process.env.DATABASE_URL
  delete process.env.PGSSLROOTCERT
  delete process.env.PGSSLMODE
})

afterEach(() => {
  process.env = { ...ORIGINAL }
})

describe('ensureApplicationDatabase', () => {
  it('creates the database when it is absent', async () => {
    await ensureApplicationDatabase()

    expect(recorded.queries.some((q) => q.includes('CREATE DATABASE "proxy_smart"'))).toBe(true)
  })

  it('connects to the maintenance database, never to the one it is creating', async () => {
    // Connecting to the target would fail for precisely the reason we are here to fix.
    await ensureApplicationDatabase()

    expect(recorded.connectionString).toContain('/postgres')
    expect(recorded.connectionString).not.toContain('/proxy_smart')
  })

  it('does nothing when the database already exists', async () => {
    queryImpl = async () => ({ rowCount: 1 })
    await ensureApplicationDatabase()

    expect(recorded.queries.some((q) => q.startsWith('CREATE DATABASE'))).toBe(false)
  })

  it('treats a lost race as success, since several tasks boot together', async () => {
    queryImpl = async (sql) => {
      if (sql.startsWith('CREATE DATABASE')) {
        // 42P04 = duplicate_database: another task created it between our check and our create.
        throw Object.assign(new RealDatabaseError('database "proxy_smart" already exists', 0, 'error'), { code: '42P04' })
      }
      return { rowCount: 0 }
    }

    await expect(ensureApplicationDatabase()).resolves.toBeUndefined()
  })

  it('never throws when the database is unreachable', async () => {
    // The resilient file backend covers this case; throwing here would refuse to boot instead.
    queryImpl = async () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(ensureApplicationDatabase()).resolves.toBeUndefined()
  })

  it('stays out of the way when the deployment manages its own database', async () => {
    // A DATABASE_URL caller named a database directly; creating one is not ours to do.
    process.env.DATABASE_URL = 'postgresql://user:pw@host:5432/somedb'
    await ensureApplicationDatabase()

    expect(recorded.queries).toEqual([])
  })

  it('does nothing without a configured database', async () => {
    delete process.env.PGHOST
    await ensureApplicationDatabase()

    expect(recorded.queries).toEqual([])
  })
})
