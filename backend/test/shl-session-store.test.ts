// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { Pool } from 'pg'
import { ShlSessionStore, importSqliteSessions } from '../src/lib/shl/session-store'
import { SqliteShlBackend } from '../src/lib/shl/sqlite-backend'
import { PostgresShlBackend } from '../src/lib/shl/pg-backend'
import type { ShlSession } from '../src/lib/shl/session'

const url = process.env.TEST_DATABASE_URL
const pool = url ? new Pool({ connectionString: url, max: 4 }) : null
const client = () => {
  if (!pool) throw new Error('TEST_DATABASE_URL is not set')
  return pool
}

afterAll(async () => {
  await pool?.end()
})

const tmpSqlite = () => join(tmpdir(), `shl-store-${process.pid}-${randomUUID()}.sqlite`)

function mk(id: string, over: Partial<ShlSession> = {}): ShlSession {
  return {
    shl: { url: 'u', key: 'k' },
    jwe: 'jwe',
    sessionToken: `tok-${id}`,
    patientId: 'patient-1',
    fhirServerUrl: 'https://fhir.test/fhir',
    expiresAt: Date.now() + 60 * 60 * 1000,
    verifiedOnly: false,
    accessCount: 0,
    ...over,
  }
}

interface Harness {
  /** A store as one backend process sees it; a second call is a fresh process on the same storage. */
  open(): ShlSessionStore
  overwrite(id: string, column: string, text: string): Promise<void>
}

function sqliteHarness(): Harness {
  const path = tmpSqlite()
  return {
    open: () => new ShlSessionStore(new SqliteShlBackend(path, { purgeIntervalMs: 0 })),
    overwrite: async (id, column, text) => {
      const raw = new Database(path)
      raw.query(`UPDATE shl_sessions SET ${column} = ? WHERE id = ?`).run(text, id)
      raw.close()
    },
  }
}

function postgresHarness(): Harness {
  return {
    open: () => new ShlSessionStore(new PostgresShlBackend({ client, purgeIntervalMs: 0 })),
    overwrite: async (id, column, text) => {
      await client().query(`UPDATE shl_sessions SET ${column} = $1 WHERE id = $2`, [text, id])
    },
  }
}

const backends: Array<[string, () => Harness, boolean]> = [
  ['SQLite', sqliteHarness, false],
  ['Postgres', postgresHarness, !url],
]

for (const [name, harness, skip] of backends) {
  describe.skipIf(skip)(`SHL session store on ${name}`, () => {
    it('keeps a share across a restart of the process that minted it', async () => {
      const h = harness()
      const id = randomUUID()
      const minted = h.open()
      await minted.set(id, mk(id, { shareScope: { excludedTypes: ['Condition'], excludedIds: [], excludedObservationCategories: [] } }))
      minted.dispose()

      const restarted = h.open()
      try {
        expect((await restarted.getByToken(`tok-${id}`))?.session.shareScope?.excludedTypes).toEqual(['Condition'])
        expect((await restarted.get(id))?.patientId).toBe('patient-1')
      } finally {
        restarted.dispose()
      }
    })

    it('refuses to open a share whose stored scope no longer parses as a scope', async () => {
      const h = harness()
      const store = h.open()
      const id = randomUUID()
      try {
        await store.set(id, mk(id, { shareScope: { excludedTypes: ['Condition'], excludedIds: [], excludedObservationCategories: [] } }))
        await h.overwrite(id, 'share_scope', '{"excludedTypes":"Condition"}')

        expect(await store.get(id)).toBeUndefined()
        expect(await store.getByToken(`tok-${id}`)).toBeUndefined()
        expect((await store.listUnmirroredActive(500)).map((p) => p.id)).not.toContain(id)
      } finally {
        await store.delete(id)
        store.dispose()
      }
    })

    it('reads a scope stored before observation categories existed as excluding none', async () => {
      const h = harness()
      const store = h.open()
      const id = randomUUID()
      try {
        await store.set(id, mk(id))
        await h.overwrite(id, 'share_scope', '{"excludedTypes":["Condition"],"excludedIds":[]}')

        expect((await store.get(id))?.shareScope).toEqual({ excludedTypes: ['Condition'], excludedIds: [], excludedObservationCategories: [] })
      } finally {
        store.dispose()
      }
    })

    it('round-trips write scope and accepts only the first attestation', async () => {
      const store = harness().open()
      const id = randomUUID()
      const first = { name: 'Dr. Who', nameSource: 'recipient' as const, signature: 'data:image/png;base64,AA', signedAt: 1 }
      try {
        await store.set(id, mk(id, { writeScope: { dicom: true } }))

        expect(await store.recordAttestation(id, first)).toBe(true)
        expect(await store.recordAttestation(id, { ...first, name: 'Someone else' })).toBe(false)
        const session = await store.get(id)
        expect(session?.writeScope).toEqual({ dicom: true })
        expect(session?.attestation).toEqual(first)
      } finally {
        store.dispose()
      }
    })

    it('counts opens in total and per distinct device, and forgets both on delete', async () => {
      const store = harness().open()
      const id = randomUUID()
      try {
        await store.set(id, mk(id))
        await store.incrementAccessCount(id)
        await store.incrementAccessCount(id)
        await store.recordAccess(id, 'device-a')
        await store.recordAccess(id, 'device-a')
        await store.recordAccess(id, 'device-b')

        expect((await store.get(id))?.accessCount).toBe(2)
        expect(await store.distinctDeviceCount(id)).toBe(2)

        await store.delete(id)
        expect(await store.get(id)).toBeUndefined()
        expect(await store.distinctDeviceCount(id)).toBe(0)
      } finally {
        store.dispose()
      }
    })

    it('lists unmirrored active sessions until marked, and never expired ones', async () => {
      const store = harness().open()
      const [a, b, expired] = [randomUUID(), randomUUID(), randomUUID()]
      try {
        await store.set(a, mk(a))
        await store.set(b, mk(b))
        await store.set(expired, mk(expired, { expiresAt: Date.now() - 1000 }))

        let pending = (await store.listUnmirroredActive(500)).map((p) => p.id)
        expect(pending).toEqual(expect.arrayContaining([a, b]))
        expect(pending).not.toContain(expired)

        await store.markConsentMirrored(a)
        pending = (await store.listUnmirroredActive(500)).map((p) => p.id)
        expect(pending).not.toContain(a)
        expect(pending).toContain(b)
      } finally {
        store.dispose()
      }
    })
  })
}

describe.skipIf(!url)('moving SQLite shares into Postgres', () => {
  it('imports unexpired sessions once and keeps their bookkeeping', async () => {
    const path = tmpSqlite()
    const [live, mirrored, expired] = [randomUUID(), randomUUID(), randomUUID()]
    const legacy = new ShlSessionStore(new SqliteShlBackend(path, { purgeIntervalMs: 0 }))
    await legacy.set(live, mk(live, { accessCount: 3 }))
    await legacy.set(mirrored, mk(mirrored))
    await legacy.set(expired, mk(expired, { expiresAt: Date.now() - 1000 }))
    await legacy.markConsentMirrored(mirrored)
    await legacy.recordAccess(live, 'device-a')
    legacy.dispose()

    const backend = new PostgresShlBackend({ client, purgeIntervalMs: 0 })
    const store = new ShlSessionStore(backend, { prepare: () => importSqliteSessions(path, backend) })
    try {
      expect((await store.getByToken(`tok-${live}`))?.session.accessCount).toBe(3)
      expect(await store.distinctDeviceCount(live)).toBe(1)
      expect(await store.get(expired)).toBeUndefined()
      const pending = (await store.listUnmirroredActive(500)).map((p) => p.id)
      expect(pending).toContain(live)
      expect(pending).not.toContain(mirrored)
      expect(existsSync(path)).toBe(false)
      expect(existsSync(`${path}.imported`)).toBe(true)
    } finally {
      await store.delete(live)
      await store.delete(mirrored)
      store.dispose()
    }
  })
})
