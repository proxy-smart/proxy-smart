// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ShlSession } from '../src/lib/shl-session-store'

const dbPath = join(tmpdir(), `shl-integrity-test-${process.pid}.sqlite`)

let store: typeof import('../src/lib/shl-session-store').shlSessionStore
let raw: Database

beforeAll(async () => {
  process.env.SHL_DB_PATH = dbPath
  store = (await import('../src/lib/shl-session-store')).shlSessionStore
  raw = new Database(dbPath)
})

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

describe('shlSessionStore stored-JSON integrity', () => {
  it('refuses to open a share whose stored scope no longer parses as a scope', () => {
    store.set('corrupt', mk('corrupt', { shareScope: { excludedTypes: ['Condition'], excludedIds: [], excludedObservationCategories: [] } }))
    raw.prepare('UPDATE shl_sessions SET share_scope = ? WHERE id = ?').run('{"excludedTypes":"Condition"}', 'corrupt')

    expect(store.get('corrupt')).toBeUndefined()
    expect(store.getByToken('tok-corrupt')).toBeUndefined()
    expect(store.listUnmirroredActive().map((p) => p.id)).not.toContain('corrupt')
  })

  it('reads a scope stored before observation categories existed as excluding none', () => {
    store.set('legacy', mk('legacy'))
    raw.prepare('UPDATE shl_sessions SET share_scope = ? WHERE id = ?').run('{"excludedTypes":["Condition"],"excludedIds":[]}', 'legacy')

    expect(store.get('legacy')?.shareScope).toEqual({
      excludedTypes: ['Condition'],
      excludedIds: [],
      excludedObservationCategories: [],
    })
  })

  it('round-trips write scope and attestation', () => {
    const attestation = { name: 'Dr. Who', nameSource: 'recipient' as const, signature: 'data:image/png;base64,AA', signedAt: 1 }
    store.set('full', mk('full', { writeScope: { dicom: true }, attestation }))

    const session = store.get('full')
    expect(session?.writeScope).toEqual({ dicom: true })
    expect(session?.attestation).toEqual(attestation)
  })
})
