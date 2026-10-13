// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileAppStateBackend,
  MemoryAppStateBackend,
  PostgresAppStateBackend,
  type AppStateBackend,
  type AppStateRecord,
} from '../src/lib/app-state/store'
import { Pool } from 'pg'

const CODE = 'https://app.example.org|prefs'
const NO_LIMIT = 1000
const SUBJECT = 'https://proxy.example.org/fhir/Patient/a'

function record(id: string, overrides: Partial<AppStateRecord> = {}): AppStateRecord {
  const subject = overrides.subject === undefined ? SUBJECT : overrides.subject
  return {
    id,
    version: 1,
    stateCode: CODE,
    subject,
    clientId: 'demo-app',
    resource: {
      resourceType: 'Basic',
      id,
      meta: { versionId: String(overrides.version ?? 1) },
      code: { coding: [{ system: 'https://app.example.org', code: 'prefs' }] },
      ...(subject ? { subject: { reference: subject } } : {}),
      extension: [{ url: 'https://app.example.org/v1', valueString: '{"theme":"dark"}' }],
    },
    ...overrides,
  }
}

function contract(name: string, make: () => Promise<{ backend: AppStateBackend; cleanup: () => Promise<void> }>) {
  describe(`${name} app-state backend`, () => {
    async function withBackend(run: (backend: AppStateBackend) => Promise<void>) {
      const { backend, cleanup } = await make()
      try {
        await run(backend)
      } finally {
        await cleanup()
      }
    }

    it('returns what was inserted', () => withBackend(async (backend) => {
      await backend.insert(record('r1'), NO_LIMIT)
      const got = await backend.get('r1')
      expect(got?.version).toBe(1)
      expect(got?.resource.extension?.[0]?.valueString).toBe('{"theme":"dark"}')
      expect(await backend.get('missing')).toBeNull()
    }))

    it('replaces only at the expected version', () => withBackend(async (backend) => {
      await backend.insert(record('r2'), NO_LIMIT)
      expect(await backend.replace(record('r2', { version: 2 }), 1)).toBe(true)
      expect(await backend.replace(record('r2', { version: 2 }), 1)).toBe(false)
      expect((await backend.get('r2'))?.version).toBe(2)
    }))

    it('deletes only at the expected version', () => withBackend(async (backend) => {
      await backend.insert(record('r3'), NO_LIMIT)
      expect(await backend.remove('r3', 2)).toBe(false)
      expect(await backend.remove('r3', 1)).toBe(true)
      expect(await backend.get('r3')).toBeNull()
      expect(await backend.remove('r3', 1)).toBe(false)
    }))

    it('searches by exact code and subject, and by missing subject', () => withBackend(async (backend) => {
      await backend.insert(record('s1'), NO_LIMIT)
      await backend.insert(record('s2', { subject: null }), NO_LIMIT)
      await backend.insert(record('s3', { stateCode: 'https://app.example.org|other' }), NO_LIMIT)
      await backend.insert(record('s4', { subject: 'https://proxy.example.org/fhir/Patient/b' }), NO_LIMIT)

      expect((await backend.search({ stateCode: CODE, subject: SUBJECT })).map((r) => r.id)).toEqual(['s1'])
      expect((await backend.search({ stateCode: CODE, subject: null })).map((r) => r.id)).toEqual(['s2'])
    }))

    it('refuses an insert at the per-(code, subject) limit', () => withBackend(async (backend) => {
      expect(await backend.insert(record('l1'), 2)).toBe(true)
      expect(await backend.insert(record('l2', { subject: null }), 2)).toBe(true)
      expect(await backend.insert(record('l3'), 2)).toBe(true)
      expect(await backend.insert(record('l4'), 2)).toBe(false)
      expect(await backend.get('l4')).toBeNull()
      expect(await backend.insert(record('l5', { subject: null }), 2)).toBe(true)
    }))

    it('holds the limit under concurrent inserts', () => withBackend(async (backend) => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => backend.insert(record(`c${i}`), 3)))
      expect(results.filter(Boolean)).toHaveLength(3)
      expect(await backend.search({ stateCode: CODE, subject: SUBJECT })).toHaveLength(3)
    }))
  })
}

contract('memory', async () => ({ backend: new MemoryAppStateBackend(), cleanup: async () => {} }))

contract('file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-state-'))
  const path = join(dir, 'app-state.json')
  const first = new FileAppStateBackend(path)
  return {
    backend: {
      insert: (r, limit) => first.insert(r, limit),
      replace: (r, v) => first.replace(r, v),
      remove: (id, v) => first.remove(id, v),
      get: (id) => new FileAppStateBackend(path).get(id),
      search: (q) => new FileAppStateBackend(path).search(q),
    },
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  }
})

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const pool = testDatabaseUrl ? new Pool({ connectionString: testDatabaseUrl, max: 8 }) : null

afterAll(async () => {
  await pool?.end()
})

if (pool) {
  contract('postgres', async () => {
    const table = `smart_app_state_test_${crypto.randomUUID().replaceAll('-', '')}`
    return {
      backend: new PostgresAppStateBackend({ table, pool: () => pool }),
      cleanup: async () => { await pool.query(`DROP TABLE IF EXISTS ${table}`) },
    }
  })
}
