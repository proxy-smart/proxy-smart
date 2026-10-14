/**
 * Unit tests for the DCR client reaper — the sweep that enforces `maxClientLifetime`.
 *
 * The setting has existed (365 days, admin-editable, shown in the UI) and stamped `expires_at`
 * on every dynamically-registered client since DCR shipped, and nothing ever read it. These
 * tests pin the policy that now does, with the emphasis on what it must NOT delete: reaping is
 * irreversible and the blast radius is somebody's working integration.
 */
import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_GRACE_DAYS,
  isReapable,
  reapExpiredClients,
  verdictFor,
} from '../src/lib/dcr-client-reaper'
import { MASKED_SECRET } from '../src/lib/secret-mask'
import { fakeKcAdmin } from './helpers/keycloak-admin'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const GRACE = DEFAULT_GRACE_DAYS * DAY

/** A dynamically-registered client, expired `daysAgo` days ago unless told otherwise. */
function dcrClient(overrides: Record<string, unknown> = {}, attributes: Record<string, string> = {}) {
  return {
    id: 'uuid-1',
    clientId: 'smart_app_test',
    enabled: true,
    attributes: { dynamic_registration: 'true', expires_at: String(NOW - DAY), ...attributes },
    ...overrides,
  }
}

describe('what the reaper is allowed to touch', () => {
  it('ignores a client that was not dynamically registered', () => {
    // A first-party client from realm-export must never be in scope, expiry stamp or not.
    const firstParty = dcrClient({}, { dynamic_registration: 'false' })
    expect(isReapable(firstParty)).toBe(false)
    expect(verdictFor(firstParty, NOW, GRACE)).toBe('keep')
  })

  it('ignores a DCR client with no expires_at', () => {
    // Absence means no lifetime was ever agreed — every client registered before the attribute
    // existed looks like this. Treating it as long-expired would delete the whole backlog.
    const unstamped = dcrClient({}, { expires_at: '' })
    expect(isReapable(unstamped)).toBe(false)
    expect(verdictFor(unstamped, NOW, GRACE)).toBe('keep')
  })

  it('ignores an unparseable expires_at rather than guessing', () => {
    expect(verdictFor(dcrClient({}, { expires_at: 'soon' }), NOW, GRACE)).toBe('keep')
  })

  it('leaves a client alone before its expiry', () => {
    expect(verdictFor(dcrClient({}, { expires_at: String(NOW + DAY) }), NOW, GRACE)).toBe('keep')
  })
})

describe('phase one: disable at expiry', () => {
  it('disables a client that has passed expires_at', () => {
    expect(verdictFor(dcrClient(), NOW, GRACE)).toBe('disable')
  })

  it('disables exactly at the boundary, not a day later', () => {
    expect(verdictFor(dcrClient({}, { expires_at: String(NOW) }), NOW, GRACE)).toBe('disable')
  })

  it('records expired_at and flips enabled, leaving other attributes intact', async () => {
    const updates: { id: string; payload: Record<string, unknown> }[] = []
    const admin = {
      clients: {
        find: async () => [dcrClient({}, { smart_app: 'true' })],
        update: async (where: { id: string }, payload: Record<string, unknown>) => {
          updates.push({ id: where.id, payload })
        },
        del: async () => {
          throw new Error('must not delete in phase one')
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const result = await reapExpiredClients(admin, { now: NOW })

    expect(result.disabled).toEqual(['smart_app_test'])
    expect(result.deleted).toEqual([])
    const attrs = updates[0].payload.attributes as Record<string, string>
    expect(updates[0].payload.enabled).toBe(false)
    expect(attrs.expired_at).toBe(String(NOW))
    expect(attrs.smart_app).toBe('true')
  })

  it('does not write a masked secret back as the real one (Keycloak 26.8 masks it for view-only callers)', async () => {
    const fake = fakeKcAdmin({ clients: [dcrClient({ secret: MASKED_SECRET })] })
    await reapExpiredClients(fake.admin, { now: NOW })
    expect(fake.updated[0].payload.enabled).toBe(false)
    expect('secret' in fake.updated[0].payload).toBe(false)
  })
})

describe('phase two: delete after the grace period', () => {
  const disabledSince = (ms: number) =>
    dcrClient({ enabled: false }, { expired_at: String(NOW - ms) })

  it('keeps a disabled client until the grace period elapses', () => {
    expect(verdictFor(disabledSince(GRACE - DAY), NOW, GRACE)).toBe('keep')
  })

  it('deletes once the grace period has elapsed', () => {
    expect(verdictFor(disabledSince(GRACE), NOW, GRACE)).toBe('delete')
  })

  it('spares a client somebody re-enabled, however long ago it expired', () => {
    // The whole point of two phases: re-enabling is a reprieve, not a delay.
    const rescued = dcrClient({ enabled: true }, { expired_at: String(NOW - GRACE * 10) })
    expect(verdictFor(rescued, NOW, GRACE)).toBe('keep')
  })

  it('does not disable twice — an already-stamped client goes straight to the phase-two rule', () => {
    const stamped = dcrClient({ enabled: false }, { expired_at: String(NOW - DAY) })
    expect(verdictFor(stamped, NOW, GRACE)).toBe('keep')
  })
})

describe('sweep resilience', () => {
  it('keeps going when Keycloak refuses one client', async () => {
    const deleted: string[] = []
    const admin = {
      clients: {
        find: async () => [
          dcrClient({ id: 'a', clientId: 'bad', enabled: false }, { expired_at: String(NOW - GRACE) }),
          dcrClient({ id: 'b', clientId: 'good', enabled: false }, { expired_at: String(NOW - GRACE) }),
        ],
        update: async () => {},
        del: async ({ id }: { id: string }) => {
          if (id === 'a') throw new Error('keycloak said no')
          deleted.push(id)
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const result = await reapExpiredClients(admin, { now: NOW })

    expect(deleted).toEqual(['b'])
    expect(result.deleted).toEqual(['good'])
  })

  it('returns empty rather than throwing when the client list cannot be read', async () => {
    const admin = {
      clients: {
        find: async () => {
          throw new Error('keycloak unreachable')
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    expect(await reapExpiredClients(admin, { now: NOW })).toEqual({ disabled: [], deleted: [] })
  })

  it('touches nothing when every client is in date', async () => {
    let called = false
    const admin = {
      clients: {
        find: async () => [dcrClient({}, { expires_at: String(NOW + DAY) })],
        update: async () => {
          called = true
        },
        del: async () => {
          called = true
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    await reapExpiredClients(admin, { now: NOW })
    expect(called).toBe(false)
  })
})
