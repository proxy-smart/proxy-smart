// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
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
import { getSharedPool } from '../src/lib/pg-pool'

const CODE = 'https://app.example.org|prefs'
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
      await backend.insert(record('r1'))
      const got = await backend.get('r1')
      expect(got?.version).toBe(1)
      expect(got?.resource.extension?.[0]?.valueString).toBe('{"theme":"dark"}')
      expect(await backend.get('missing')).toBeNull()
    }))

    it('replaces only at the expected version', () => withBackend(async (backend) => {
      await backend.insert(record('r2'))
      expect(await backend.replace(record('r2', { version: 2 }), 1)).toBe(true)
      expect(await backend.replace(record('r2', { version: 2 }), 1)).toBe(false)
      expect((await backend.get('r2'))?.version).toBe(2)
    }))

    it('deletes only at the expected version', () => withBackend(async (backend) => {
      await backend.insert(record('r3'))
      expect(await backend.remove('r3', 2)).toBe(false)
      expect(await backend.remove('r3', 1)).toBe(true)
      expect(await backend.get('r3')).toBeNull()
      expect(await backend.remove('r3', 1)).toBe(false)
    }))

    it('searches by exact code and subject, and by missing subject', () => withBackend(async (backend) => {
      await backend.insert(record('s1'))
      await backend.insert(record('s2', { subject: null }))
      await backend.insert(record('s3', { stateCode: 'https://app.example.org|other' }))
      await backend.insert(record('s4', { subject: 'https://proxy.example.org/fhir/Patient/b' }))

      expect((await backend.search({ stateCode: CODE, subject: SUBJECT })).map((r) => r.id)).toEqual(['s1'])
      expect((await backend.search({ stateCode: CODE, subject: null })).map((r) => r.id)).toEqual(['s2'])
      expect(await backend.count({ stateCode: CODE, subject: SUBJECT })).toBe(1)
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
      insert: (r) => first.insert(r),
      replace: (r, v) => first.replace(r, v),
      remove: (id, v) => first.remove(id, v),
      get: (id) => new FileAppStateBackend(path).get(id),
      search: (q) => new FileAppStateBackend(path).search(q),
      count: (q) => new FileAppStateBackend(path).count(q),
    },
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  }
})

const testDatabaseUrl = process.env.APP_STATE_TEST_DATABASE_URL
if (testDatabaseUrl) {
  contract('postgres', async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    const table = `smart_app_state_test_${crypto.randomUUID().replaceAll('-', '')}`
    const backend = new PostgresAppStateBackend(table)
    return {
      backend,
      cleanup: async () => { await getSharedPool().query(`DROP TABLE IF EXISTS ${table}`) },
    }
  })
}
