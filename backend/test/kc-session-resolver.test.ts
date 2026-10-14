/**
 * Unit tests for kc-session-resolver.ts
 *
 * Tests the autoResolvePatient flow by mocking KcAdminClient via DI.
 * Reproduces the beta bug where the patient picker still shows despite
 * the user having fhirUser=Patient/max-nussbaumer on their KC profile.
 *
 * NOTE: We do NOT use mock.module for any @/ path-aliased modules because
 * Bun's mock.module does not reliably intercept them on Linux CI.
 * Instead we use dependency injection (adminClientFactory parameter).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { CallbackParams } from '@proxy-smart/auth'
import { makeLaunchSession } from '@proxy-smart/auth/testing'
import { useTestEnv } from './helpers/test-env'

// ── Mock admin client via dependency injection ──────────────────────────
// NOTE: Bun's mock.module does not reliably intercept modules on Linux CI
// (both npm packages and path-aliased local modules fail). Instead of
// mock.module, we use dependency injection: autoResolvePatient accepts an
// optional adminClientFactory parameter that we pass directly in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClientsFind = mock((): Promise<any[]> => Promise.resolve([]))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClientsListSessions = mock((): Promise<any[]> => Promise.resolve([]))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUsersFindOne = mock((): Promise<any> => Promise.resolve(null))

const mockAdminClient = {
  accessToken: 'mock-admin-token',
  getAccessToken: () => Promise.resolve('mock-admin-token'),
  clients: {
    find: mockClientsFind,
    listSessions: mockClientsListSessions,
  },
  users: {
    findOne: mockUsersFindOne,
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdminFactory = () => Promise.resolve(mockAdminClient as any)

// Import directly — no mock.module needed for kc-admin-factory
const { autoResolvePatient } = await import('@/lib/kc-session-resolver')

// ── Test fixtures (matching beta state) ─────────────────────────────────
const KC_CLIENT_UUID = '3c6b3282-7f49-480d-84c6-a24c31e08710'
const SESSION_STATE = 'a1b2c3d4-5678-9012-3456-789012345678'
const USER_ID = '91b2868f-6efe-4806-8534-153a7600a74d'

const SESSION = {
  clientRedirectUri: 'https://beta.proxy-smart.com/apps/patient-portal/',
  clientState: 'abc123',
  clientId: 'patient-portal',
  scope: 'openid fhirUser launch/patient patient/*.read',
  needsPatientPicker: true,
}

function makeCallbackParams(overrides?: Partial<CallbackParams>): CallbackParams {
  return {
    state: 'session-key-uuid',
    code: 'auth-code-from-kc',
    session_state: SESSION_STATE,
    ...overrides,
  }
}

describe('kc-session-resolver: autoResolvePatient', () => {
  useTestEnv({
    KEYCLOAK_BASE_URL: 'http://keycloak:8080/auth',
    KEYCLOAK_REALM: 'proxy-smart',
    KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
    KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-service-secret',
  })

  beforeEach(() => {
    mockClientsFind.mockClear()
    mockClientsListSessions.mockClear()
    mockUsersFindOne.mockClear()

    // Default: client exists
    mockClientsFind.mockResolvedValue([{ id: KC_CLIENT_UUID, clientId: 'patient-portal' }])
    // Default: no sessions
    mockClientsListSessions.mockResolvedValue([])
    // Default: user not found
    mockUsersFindOne.mockResolvedValue(null)
  })

  it('returns null when session_state is missing from params', async () => {
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams({ session_state: undefined }), mockAdminFactory)
    expect(result).toBeNull()
    // Admin client should not be called when there's no session_state
    expect(mockClientsFind).not.toHaveBeenCalled()
  })

  it('returns null when OIDC client is not found in Keycloak', async () => {
    mockClientsFind.mockResolvedValue([])
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('returns null when no sessions exist for the client', async () => {
    mockClientsListSessions.mockResolvedValue([])
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('returns null when session_state does not match any session id', async () => {
    mockClientsListSessions.mockResolvedValue([
      { id: 'different-session-id', userId: 'some-user', username: 'other' },
    ])
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('returns null when user has fhirUser=Practitioner/* (not a patient)', async () => {
    mockClientsListSessions.mockResolvedValue([
      { id: SESSION_STATE, userId: USER_ID, username: 'doctor' },
    ])
    mockUsersFindOne.mockResolvedValue({
      id: USER_ID,
      username: 'doctor',
      attributes: { fhirUser: ['Practitioner/example-practitioner'] },
    })

    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('returns null when user has no fhirUser attribute at all', async () => {
    mockClientsListSessions.mockResolvedValue([
      { id: SESSION_STATE, userId: USER_ID, username: 'maxivities@gmail.com' },
    ])
    mockUsersFindOne.mockResolvedValue({
      id: USER_ID,
      username: 'maxivities@gmail.com',
      attributes: {},
    })

    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('catches exceptions and returns null gracefully', async () => {
    mockClientsFind.mockRejectedValue(new Error('Connection refused'))
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('BUG: what if admin-service lacks realm-management roles (403 on listSessions)?', async () => {
    mockClientsListSessions.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } })
    )
    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })

  it('BUG ROOT CAUSE: 403 on users.findOne when admin-service lacks view-users role', async () => {
    // This is the EXACT scenario on beta:
    // 1. admin.clients.find() works (view-clients role ✓)
    // 2. admin.clients.listSessions() works (view-clients role ✓)
    // 3. admin.users.findOne() FAILS with 403 (view-users role ✗)
    // The exception is caught, logged at debug, and null is returned.
    // Patient picker shows because autoResolvePatient returned null.
    mockClientsListSessions.mockResolvedValue([
      { id: SESSION_STATE, userId: USER_ID, username: 'quotentiroler' },
    ])
    mockUsersFindOne.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { error: 'unknown_error' } },
      })
    )

    const result = await autoResolvePatient(makeLaunchSession(SESSION), makeCallbackParams(), mockAdminFactory)
    expect(result).toBeNull()
  })
})
