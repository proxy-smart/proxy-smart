// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The jti → launch-context store behind SMART 2.2 introspection: lifecycle, validation, client
 * binding, and the shared backend that lets another node answer for a token it did not issue.
 */

import { describe, it, expect } from 'bun:test'
import {
  TokenContextStore,
  type SharedTokenContextBackend,
  type StoredTokenContext,
  type TokenContext,
  type TokenContextStoreOptions,
} from '../src/lib/token-context-store'

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600

/** Each test gets its own store, disposed when the body finishes. */
async function withStore(run: (store: TokenContextStore) => Promise<void>, options: TokenContextStoreOptions = {}) {
  const store = new TokenContextStore({ maxEntries: 100, cleanupIntervalMs: 60_000, ...options })
  try {
    await run(store)
  } finally {
    store.dispose()
  }
}

/** One shared database seen by several nodes; it round-trips through JSON as Postgres would. */
class FakeSharedBackend implements SharedTokenContextBackend {
  readonly rows = new Map<string, StoredTokenContext>()
  fetches = 0
  failing = false

  async put(jti: string, context: unknown, expiresAt: number): Promise<void> {
    if (this.failing) throw new Error('database unreachable')
    this.rows.set(jti, { context: JSON.parse(JSON.stringify(context)), expiresAt })
  }

  async fetch(jti: string, now: number): Promise<StoredTokenContext | null> {
    this.fetches++
    if (this.failing) throw new Error('database unreachable')
    const row = this.rows.get(jti)
    return row && row.expiresAt > now ? row : null
  }

  async remove(jti: string): Promise<void> {
    if (this.failing) throw new Error('database unreachable')
    this.rows.delete(jti)
  }

  dispose(): void {}
}

/** Two nodes in front of one database. */
async function withCluster(
  run: (nodeA: TokenContextStore, nodeB: TokenContextStore, shared: FakeSharedBackend) => Promise<void>,
  options: TokenContextStoreOptions = {},
) {
  const shared = new FakeSharedBackend()
  await withStore((nodeA) => withStore((nodeB) => run(nodeA, nodeB, shared), { shared, ...options }), { shared, ...options })
}

describe('TokenContextStore', () => {
  it('stores and retrieves context by JTI', () => withStore(async (store) => {
    await store.set('jti-abc', { patient: 'patient-123', fhirUser: 'Patient/patient-123', clientId: 'app-1', exp: inAnHour() })

    expect(await store.get('jti-abc')).toMatchObject({ patient: 'patient-123', fhirUser: 'Patient/patient-123', clientId: 'app-1' })
  }))

  it('returns null for an unknown JTI', () => withStore(async (store) => {
    expect(await store.get('nonexistent')).toBeNull()
  }))

  it('does not store a context whose token has already expired', () => withStore(async (store) => {
    await store.set('jti-expired', { patient: 'patient-old', exp: Math.floor(Date.now() / 1000) - 60 })

    expect(await store.get('jti-expired')).toBeNull()
  }))

  it('uses a default TTL when exp is not provided', () => withStore(async (store) => {
    await store.set('jti-no-exp', { patient: 'patient-no-exp' })

    expect((await store.get('jti-no-exp'))?.patient).toBe('patient-no-exp')
  }))

  it('evicts an entry when maxEntries is exceeded', () => withStore(async (store) => {
    for (const n of [1, 2, 3, 4]) await store.set(`jti-${n}`, { patient: `p${n}`, exp: inAnHour() })

    expect(store.size()).toBe(3)
    expect(await store.get('jti-1')).toBeNull()
    expect((await store.get('jti-4'))?.patient).toBe('p4')
  }, { maxEntries: 3 }))

  it('reports its size', () => withStore(async (store) => {
    expect(store.size()).toBe(0)
    await store.set('a', { patient: '1', exp: inAnHour() })
    await store.set('b', { patient: '2', exp: inAnHour() })

    expect(store.size()).toBe(2)
  }))

  it('forgets a deleted context', () => withStore(async (store) => {
    await store.set('jti-gone', { patient: 'p1', exp: inAnHour() })
    await store.delete('jti-gone')

    expect(await store.get('jti-gone')).toBeNull()
  }))

  it('dispose clears all entries', () => withStore(async (store) => {
    await store.set('x', { patient: 'px', exp: inAnHour() })
    store.dispose()

    expect(store.size()).toBe(0)
    expect(await store.get('x')).toBeNull()
  }))

  it('stores the full launch context', () => withStore(async (store) => {
    const ctx: TokenContext = {
      patient: 'patient-full',
      encounter: 'encounter-full',
      fhirUser: 'Practitioner/dr-house',
      intent: 'order-sign',
      smart_style_url: 'https://ehr.example.com/styles/smart-v1.json',
      tenant: 'org-alpha',
      need_patient_banner: false,
      clientId: 'ehr-portal',
      exp: inAnHour(),
      act: { client_id: 'scribe', act: { client_id: 'portal' } },
      fhirContext: [{ reference: 'ImagingStudy/img-1' }],
    }
    await store.set('jti-full', ctx)

    expect(await store.get('jti-full')).toEqual(ctx)
  }))

  describe('input validation', () => {
    for (const [name, jti, context] of [
      ['an empty JTI', '', { patient: 'should-not-store' }],
      ['a JTI over the length cap', 'a'.repeat(200), { patient: 'should-not-store' }],
      ['a patient id with path traversal', 'jti-inject', { patient: '../../../etc/passwd' }],
      ['a patient id with spaces', 'jti-inject2', { patient: 'patient id with spaces' }],
      ['a malformed fhirUser', 'jti-badfhir', { fhirUser: '<script>alert(1)</script>' }],
    ] as const) {
      it(`rejects ${name}`, () => withStore(async (store) => {
        await store.set(jti, { ...context, exp: inAnHour() })
        expect(store.size()).toBe(0)
      }))
    }

    it('accepts valid FHIR ids and an absolute fhirUser', () => withStore(async (store) => {
      await store.set('jti-good', { patient: 'test-patient.123', encounter: 'enc-456', fhirUser: 'https://fhir.example.com/Patient/t-1', exp: inAnHour() })

      expect(await store.get('jti-good')).toMatchObject({ patient: 'test-patient.123', fhirUser: 'https://fhir.example.com/Patient/t-1' })
    }))

    it('truncates an overly long intent', () => withStore(async (store) => {
      await store.set('jti-longintent', { intent: 'x'.repeat(500), exp: inAnHour() })

      expect((await store.get('jti-longintent'))?.intent?.length).toBeLessThanOrEqual(128)
    }))
  })

  describe('client binding', () => {
    it('returns the context without a client to check', () => withStore(async (store) => {
      await store.set('jti-unbound', { patient: 'p1', clientId: 'app-a', exp: inAnHour() })
      expect((await store.get('jti-unbound'))?.patient).toBe('p1')
    }))

    it('returns the context to the client it was issued to', () => withStore(async (store) => {
      await store.set('jti-bound', { patient: 'p2', clientId: 'app-b', exp: inAnHour() })
      expect((await store.get('jti-bound', 'app-b'))?.patient).toBe('p2')
    }))

    it('refuses the context to another client', () => withStore(async (store) => {
      await store.set('jti-mismatch', { patient: 'p3', clientId: 'app-c', exp: inAnHour() })
      expect(await store.get('jti-mismatch', 'malicious-client')).toBeNull()
    }))

    it('returns a context stored without a client to anyone', () => withStore(async (store) => {
      await store.set('jti-noclient', { patient: 'p4', exp: inAnHour() })
      expect((await store.get('jti-noclient', 'any-client'))?.patient).toBe('p4')
    }))
  })

  it('returns a copy that cannot mutate the store', () => withStore(async (store) => {
    await store.set('jti-immutable', { patient: 'original', clientId: 'app-x', act: { client_id: 'scribe' }, exp: inAnHour() })
    const result = await store.get('jti-immutable')
    if (!result) throw new Error('context missing')
    result.patient = 'tampered'

    expect((await store.get('jti-immutable'))?.patient).toBe('original')
  }))

  it('caps the TTL of a far-future exp and still stores the context', () => withStore(async (store) => {
    await store.set('jti-farfuture', { patient: 'pf', exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 })
    expect((await store.get('jti-farfuture'))?.patient).toBe('pf')
  }))
})

describe('TokenContextStore across nodes', () => {
  it('answers on one node for a token another node issued', () => withCluster(async (nodeA, nodeB) => {
    await nodeA.set('jti-issued-on-a', { patient: 'p-42', clientId: 'app', exp: inAnHour() })

    expect((await nodeB.get('jti-issued-on-a', 'app'))?.patient).toBe('p-42')
  }))

  it('applies client binding to a context read from the shared backend', () => withCluster(async (nodeA, nodeB) => {
    await nodeA.set('jti-bound', { patient: 'p-42', clientId: 'app', exp: inAnHour() })

    expect(await nodeB.get('jti-bound', 'someone-else')).toBeNull()
  }))

  it('sanitises what it reads back, so a tampered row is refused', () => withCluster(async (_nodeA, nodeB, shared) => {
    shared.rows.set('jti-tampered', { context: { patient: '../etc/passwd', clientId: 'app' }, expiresAt: Date.now() + 60_000 })
    shared.rows.set('jti-junk', { context: 'not an object', expiresAt: Date.now() + 60_000 })

    expect(await nodeB.get('jti-tampered')).toBeNull()
    expect(await nodeB.get('jti-junk')).toBeNull()
  }))

  it('keeps a context read from the shared backend, so repeat lookups stay local', () => withCluster(async (nodeA, nodeB, shared) => {
    await nodeA.set('jti-hot', { patient: 'p-1', exp: inAnHour() })
    await nodeB.get('jti-hot')
    await nodeB.get('jti-hot')

    expect(shared.fetches).toBe(1)
  }))

  it('rereads a shared context once its local copy lapses', () => withCluster(async (nodeA, nodeB, shared) => {
    await nodeA.set('jti-lapse', { patient: 'p-1', exp: inAnHour() })
    await nodeB.get('jti-lapse')
    await Bun.sleep(30)
    await nodeB.get('jti-lapse')

    expect(shared.fetches).toBe(2)
  }, { sharedCacheMs: 20 }))

  it('collapses concurrent lookups of one jti into a single read', () => withCluster(async (nodeA, nodeB, shared) => {
    await nodeA.set('jti-burst', { patient: 'p-1', exp: inAnHour() })
    await Promise.all([nodeB.get('jti-burst'), nodeB.get('jti-burst'), nodeB.get('jti-burst')])

    expect(shared.fetches).toBe(1)
  }))

  it('remembers a miss briefly, so tokens without context do not query on every request', () => withCluster(async (_nodeA, nodeB, shared) => {
    await nodeB.get('jti-unknown')
    await nodeB.get('jti-unknown')

    expect(shared.fetches).toBe(1)
  }))

  it('forgets a remembered miss once the context is stored on that node', () => withCluster(async (_nodeA, nodeB) => {
    await nodeB.get('jti-late')
    await nodeB.set('jti-late', { patient: 'p-9', exp: inAnHour() })

    expect((await nodeB.get('jti-late'))?.patient).toBe('p-9')
  }))

  it('removes a deleted context from the shared backend', () => withCluster(async (nodeA, nodeB) => {
    await nodeA.set('jti-revoked', { patient: 'p-1', exp: inAnHour() })
    await nodeA.delete('jti-revoked')

    expect(await nodeB.get('jti-revoked')).toBeNull()
  }))

  it('keeps working on the issuing node while the shared backend is down', () => withCluster(async (nodeA, _nodeB, shared) => {
    shared.failing = true
    await nodeA.set('jti-outage', { patient: 'p-1', exp: inAnHour() })

    expect((await nodeA.get('jti-outage'))?.patient).toBe('p-1')
    expect(await nodeA.get('jti-never-stored')).toBeNull()
  }))
})
