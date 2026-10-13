// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The Postgres backends of the launch-context store and the jti replay cache, against a real
 * database. Runs when TEST_DATABASE_URL points at a disposable Postgres; skipped otherwise.
 */

import { describe, it, expect, afterAll } from 'bun:test'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { PgExpiringTable } from '../src/lib/cache/pg-expiring-table'
import { PostgresJtiBackend, JtiReplayCache } from '../src/lib/cache/jti-replay-cache'
import { PostgresTokenContextBackend } from '../src/lib/cache/pg-token-context'
import { TokenContextStore } from '../src/lib/token-context-store'

const url = process.env.TEST_DATABASE_URL
const pool = url ? new Pool({ connectionString: url, max: 4 }) : null
const client = () => {
  if (!pool) throw new Error('TEST_DATABASE_URL is not set')
  return pool
}

afterAll(async () => {
  await pool?.end()
})

describe.skipIf(!url)('shared state on Postgres', () => {
  it('creates its tables on first use, even when several nodes race to do it', async () => {
    const name = `expiring_probe_${randomUUID().replace(/-/g, '')}`
    const tables = [1, 2, 3].map(() => new PgExpiringTable({ name, columns: 'id TEXT PRIMARY KEY', client, purgeIntervalMs: 0 }))
    try {
      await Promise.all(tables.map((table) => table.query(`SELECT 1 FROM ${name}`)))
      const purged = await tables[0].query(`INSERT INTO ${name} (id, expires_at) VALUES ($1, $2), ($3, $4)`, ['old', 1, 'new', Date.now() + 60_000])

      expect(purged.rowCount).toBe(2)
      expect(await tables[0].purge()).toBe(1)
      expect((await tables[0].query(`SELECT id FROM ${name}`)).rows).toEqual([{ id: 'new' }])
    } finally {
      await client().query(`DROP TABLE IF EXISTS ${name}`)
      for (const table of tables) table.dispose()
    }
  })

  it('shares a launch context between two nodes', async () => {
    const nodeA = new TokenContextStore({ shared: new PostgresTokenContextBackend({ client, purgeIntervalMs: 0 }) })
    const nodeB = new TokenContextStore({ shared: new PostgresTokenContextBackend({ client, purgeIntervalMs: 0 }) })
    const jti = randomUUID()
    try {
      await nodeA.set(jti, {
        patient: 'p-42',
        clientId: 'app',
        act: { client_id: 'scribe' },
        fhirContext: [{ reference: 'Encounter/e-1' }],
        exp: Math.floor(Date.now() / 1000) + 300,
      })

      expect(await nodeB.get(jti, 'app')).toMatchObject({ patient: 'p-42', act: { client_id: 'scribe' }, fhirContext: [{ reference: 'Encounter/e-1' }] })
      expect(await nodeB.get(jti, 'another-app')).toBeNull()
    } finally {
      nodeA.dispose()
      nodeB.dispose()
    }
  })

  it('does not return an expired launch context and purges it', async () => {
    const backend = new PostgresTokenContextBackend({ client, purgeIntervalMs: 0 })
    const jti = randomUUID()
    try {
      await backend.put(jti, { patient: 'p-1' }, Date.now() - 1)

      expect(await backend.fetch(jti, Date.now())).toBeNull()
      await backend.purge()
      expect((await client().query('SELECT 1 FROM smart_token_context WHERE jti = $1', [jti])).rowCount).toBe(0)
    } finally {
      backend.dispose()
    }
  })

  it('deletes a launch context for every node', async () => {
    const backend = new PostgresTokenContextBackend({ client, purgeIntervalMs: 0 })
    const jti = randomUUID()
    try {
      await backend.put(jti, { patient: 'p-1' }, Date.now() + 60_000)
      await backend.remove(jti)

      expect(await backend.fetch(jti, Date.now())).toBeNull()
    } finally {
      backend.dispose()
    }
  })

  it('spends a jti once across nodes, also under a concurrent replay', async () => {
    const nodes = [1, 2, 3, 4].map(() => new JtiReplayCache({ shared: new PostgresJtiBackend({ client, purgeIntervalMs: 0 }) }))
    const jti = randomUUID()
    try {
      const results = await Promise.all(nodes.map((node) => node.spend('client-a', jti, Date.now() + 300_000)))

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await nodes[0].isSpent('client-a', jti)).toBe(true)
    } finally {
      for (const node of nodes) node.dispose()
    }
  })

  it('lets a jti be spent again once its row has expired, before any purge', async () => {
    const backend = new PostgresJtiBackend({ client, purgeIntervalMs: 0 })
    const key = randomUUID()
    try {
      expect(await backend.claim(key, Date.now() - 1, Date.now() - 2)).toBe(true)
      expect(await backend.claim(key, Date.now() + 60_000, Date.now())).toBe(true)
      expect(await backend.claim(key, Date.now() + 60_000, Date.now())).toBe(false)
    } finally {
      backend.dispose()
    }
  })
})
