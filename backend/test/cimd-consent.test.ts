// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { Pool } from 'pg'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LaunchSession } from '@proxy-smart/auth'
import {
  FileClientApprovalBackend,
  MemoryClientApprovalBackend,
  PostgresClientApprovalBackend,
  type ClientApprovalBackend,
} from '../src/lib/client-approvals'
import { createConsentGate } from '../src/routes/auth/oauth/consent'
import { consentPage } from '../src/web/consent-page'

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const IMAGING = 'https://imaging.example.com/mcp'
const SCRIBE = 'https://scribe.example.com/mcp'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const KEY = { userId: 'user-1', clientId: CLIENT_ID, resource: IMAGING, redirectUri: REDIRECT }

const session = (overrides: Partial<LaunchSession> = {}): LaunchSession => ({
  clientRedirectUri: REDIRECT,
  clientState: 'state',
  clientId: CLIENT_ID,
  scope: 'openid profile',
  aud: IMAGING,
  createdAt: 0,
  ...overrides,
})

function gate(known: Record<string, string> = { 'kc-session': 'user-1' }) {
  const approvals = new MemoryClientApprovalBackend()
  return { approvals, ...createConsentGate(approvals, async (_clientId, sessionState) => known[sessionState] ?? null, () => 1_700_000_000_000) }
}

const CALLBACK = { state: 'k', code: 'c', session_state: 'kc-session' }

describe('per-resource consent for CIMD clients', () => {
  it('asks a user who has approved nothing yet, naming them so the answer can be kept', async () => {
    expect(await gate().consentPending(session(), CALLBACK)).toEqual({ userId: 'user-1' })
  })

  it('does not ask again for the same resource and scopes', async () => {
    const { consentPending, recordConsent } = gate()
    await recordConsent({ ...session(), consentUserId: 'user-1' })
    expect(await consentPending(session(), CALLBACK)).toBeNull()
  })

  it('asks again for another resource, which the draft forbids carrying an approval to', async () => {
    const { consentPending, recordConsent } = gate()
    await recordConsent({ ...session(), consentUserId: 'user-1' })
    expect(await consentPending(session({ aud: SCRIBE }), CALLBACK)).toEqual({ userId: 'user-1' })
  })

  it('asks again for a scope beyond what was approved, then remembers both', async () => {
    const { approvals, consentPending, recordConsent } = gate()
    await recordConsent({ ...session(), consentUserId: 'user-1' })
    const wider = session({ scope: 'openid profile offline_access' })

    expect(await consentPending(wider, CALLBACK)).toEqual({ userId: 'user-1' })
    await recordConsent({ ...wider, consentUserId: 'user-1' })

    expect((await approvals.find(KEY))?.scopes).toEqual(['openid', 'profile', 'offline_access'])
    expect(await consentPending(session(), CALLBACK)).toBeNull()
  })

  it('asks again when the code would go somewhere else, such as a loopback listener', async () => {
    const { consentPending, recordConsent } = gate()
    await recordConsent({ ...session(), consentUserId: 'user-1' })
    expect(await consentPending(session({ clientRedirectUri: 'http://127.0.0.1:33418/callback' }), CALLBACK)).toEqual({ userId: 'user-1' })
  })

  it('keeps one user\'s approval from answering for another', async () => {
    const { consentPending, recordConsent } = gate({ 'kc-session': 'user-1', 'other-session': 'user-2' })
    await recordConsent({ ...session(), consentUserId: 'user-1' })
    expect(await consentPending(session(), { ...CALLBACK, session_state: 'other-session' })).toEqual({ userId: 'user-2' })
  })

  it('asks without remembering when the user cannot be identified', async () => {
    expect(await gate().consentPending(session(), { ...CALLBACK, session_state: undefined })).toEqual({})
    expect(await gate({}).consentPending(session(), CALLBACK)).toEqual({})
  })

  it('leaves clients registered another way to Keycloak\'s own consent', async () => {
    expect(await gate().consentPending(session({ clientId: 'smart_app_1' }), CALLBACK)).toBeNull()
  })
})

interface StoreUnderTest {
  write: ClientApprovalBackend
  /** A fresh instance over the same storage, as after a restart. */
  reopen: () => ClientApprovalBackend
  cleanup: () => Promise<void>
}

function contract(name: string, open: () => Promise<StoreUnderTest>) {
  describe(`client approvals (${name})`, () => {
    it('keeps one approval per key, replacing the earlier one', async () => {
      const store = await open()
      try {
        await store.write.save({ ...KEY, scopes: ['openid'], approvedAt: 1_000 })
        await store.write.save({ ...KEY, scopes: ['openid', 'profile'], approvedAt: 2_000 })
        expect(await store.reopen().find(KEY)).toEqual({ ...KEY, scopes: ['openid', 'profile'], approvedAt: 2_000 })
      } finally {
        await store.cleanup()
      }
    })

    it("lists a user's approvals, and revoking a client drops only its own and records when", async () => {
      const store = await open()
      try {
        await store.write.save({ ...KEY, scopes: ['openid'], approvedAt: 1_000 })
        await store.write.save({ ...KEY, resource: SCRIBE, scopes: ['openid'], approvedAt: 2_000 })
        await store.write.save({ ...KEY, clientId: 'smart_app_other', scopes: ['openid'], approvedAt: 3_000 })
        await store.write.save({ ...KEY, userId: 'user-2', scopes: ['openid'], approvedAt: 4_000 })

        expect((await store.reopen().forUser('user-1')).map((approval) => [approval.clientId, approval.resource]))
          .toEqual([[CLIENT_ID, IMAGING], [CLIENT_ID, SCRIBE], ['smart_app_other', IMAGING]])

        expect(await store.write.revoke({ userId: 'user-1', clientId: CLIENT_ID, revokedAt: 5_000 })).toBe(2)
        const reopened = store.reopen()
        expect((await reopened.forUser('user-1')).map((approval) => approval.clientId)).toEqual(['smart_app_other'])
        expect(await reopened.find({ ...KEY, userId: 'user-2' })).not.toBeNull()
        expect(await reopened.revokedAt('user-1', CLIENT_ID)).toBe(5_000)
        expect(await reopened.revokedAt('user-2', CLIENT_ID)).toBeNull()
      } finally {
        await store.cleanup()
      }
    })

    it('finds nothing for another resource, redirect URI or user', async () => {
      const store = await open()
      try {
        await store.write.save({ ...KEY, scopes: ['openid'], approvedAt: 1_000 })
        const reopened = store.reopen()
        expect(await reopened.find({ ...KEY, resource: SCRIBE })).toBeNull()
        expect(await reopened.find({ ...KEY, redirectUri: 'http://127.0.0.1:33418/callback' })).toBeNull()
        expect(await reopened.find({ ...KEY, userId: 'user-2' })).toBeNull()
      } finally {
        await store.cleanup()
      }
    })
  })
}

contract('memory', async () => {
  const backend = new MemoryClientApprovalBackend()
  return { write: backend, reopen: () => backend, cleanup: async () => {} }
})

contract('file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-'))
  const path = join(dir, 'client-approvals.json')
  return {
    write: new FileClientApprovalBackend(path),
    reopen: () => new FileClientApprovalBackend(path),
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  }
})

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const pool = testDatabaseUrl ? new Pool({ connectionString: testDatabaseUrl, max: 4 }) : null

afterAll(async () => {
  await pool?.end()
})

if (pool) {
  contract('postgres', async () => {
    const table = `client_approvals_test_${crypto.randomUUID().replaceAll('-', '')}`
    const backend = () => new PostgresClientApprovalBackend({ table, pool: () => pool })
    const cleanup = async () => { await pool.query(`DROP TABLE IF EXISTS ${table}, ${table}_revocations`) }
    return { write: backend(), reopen: backend, cleanup }
  })
}

describe('the consent page', () => {
  const page = (redirectUri = REDIRECT) => consentPage({
    clientName: 'Claude (claude.ai)',
    clientHost: 'claude.ai',
    clientId: CLIENT_ID,
    resource: IMAGING,
    redirectUri,
    scopes: ['openid', 'profile'],
    sessionKey: 'session-key',
    code: 'idp-code',
    action: 'https://proxy.example.com/auth/consent',
  })

  it('names the host that vouches for the client, the resource and the scopes', async () => {
    const html = await page().text()
    expect(html).toContain('claude.ai')
    expect(html).toContain(IMAGING)
    expect(html).toContain('<code>profile</code>')
    expect(html).toContain('value="approve"')
    expect(html).toContain('value="deny"')
  })

  it('warns when the code would go to a program on this computer', async () => {
    expect(await page().text()).not.toContain('Any program on this computer')
    const html = await page('http://127.0.0.1:33418/callback').text()
    expect(html).toContain('127.0.0.1:33418, a program running on this computer')
    expect(html).toContain('Any program on this computer can listen')
  })

  it('can never be framed or cached', () => {
    const { headers } = page()
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
    expect(headers.get('Cache-Control')).toBe('no-store')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
