// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { RevokedTokenList, type SharedRevocationBackend, type RevocationRow } from '../src/lib/revoked-tokens'

const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300

class FakeRevocationBackend implements SharedRevocationBackend {
  readonly rows: RevocationRow[] = []
  failing = false

  async add(jti: string, expiresAt: number): Promise<void> {
    if (this.failing) throw new Error('database unreachable')
    this.rows.push({ id: this.rows.length + 1, jti, expiresAt })
  }

  async after(id: number, now: number): Promise<RevocationRow[]> {
    if (this.failing) throw new Error('database unreachable')
    return this.rows.filter((row) => row.id > id && row.expiresAt > now)
  }

  dispose(): void {}
}

function nodes(shared: SharedRevocationBackend | null) {
  const a = new RevokedTokenList({ shared, syncIntervalMs: 0 })
  const b = new RevokedTokenList({ shared, syncIntervalMs: 0 })
  return { a, b, dispose: () => { a.dispose(); b.dispose() } }
}

describe('revoked access tokens', () => {
  it('is refused on the node that revoked it at once', async () => {
    const { a, dispose } = nodes(null)
    await a.revoke('tok-1', inFiveMinutes())
    expect(a.isRevoked('tok-1')).toBe(true)
    expect(a.isRevoked('tok-2')).toBe(false)
    dispose()
  })

  it('reaches every other node on its next sync', async () => {
    const shared = new FakeRevocationBackend()
    const { a, b, dispose } = nodes(shared)
    await a.revoke('tok-1', inFiveMinutes())

    expect(b.isRevoked('tok-1')).toBe(false)
    await b.sync()
    expect(b.isRevoked('tok-1')).toBe(true)
    dispose()
  })

  it('reads each shared row once, and skips ones already expired', async () => {
    const shared = new FakeRevocationBackend()
    const { a, b, dispose } = nodes(shared)
    await a.revoke('expired', Math.floor(Date.now() / 1000) - 1)
    await a.revoke('live', inFiveMinutes())

    await b.sync()
    await a.revoke('later', inFiveMinutes())
    await b.sync()

    expect(b.isRevoked('expired')).toBe(false)
    expect(b.isRevoked('live')).toBe(true)
    expect(b.isRevoked('later')).toBe(true)
    dispose()
  })

  it('still refuses the token locally while the shared store is down', async () => {
    const shared = new FakeRevocationBackend()
    shared.failing = true
    const { a, b, dispose } = nodes(shared)

    await a.revoke('tok-1', inFiveMinutes())
    await b.sync()

    expect(a.isRevoked('tok-1')).toBe(true)
    expect(b.isRevoked('tok-1')).toBe(false)
    dispose()
  })
})
