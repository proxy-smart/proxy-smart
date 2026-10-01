/**
 * Global Audience Binding in validateToken — Security Tests (TDD, ITEM 2)
 *
 * Root cause being fixed: `validateToken` only enforced audience when the env var
 * JWT_EXPECTED_AUDIENCE was set, and never checked `azp`. Any signature-valid,
 * non-expired realm token — including one minted for a patient-facing SMART app —
 * was accepted at /mcp, the FHIR proxy, DICOMweb, and admin routes. This is a
 * cross-audience token-replay vulnerability.
 *
 * The fix makes audience enforcement DEFAULT (fail-closed), while honouring the
 * SMART nuance that different call sites accept different audiences:
 *   - admin / MCP:     tokens for the proxy's own client(s)  → aud/azp = proxy client id
 *   - FHIR / DICOMweb: per SMART on FHIR, aud = the FHIR resource server base URL
 *
 * These tests exercise the REAL `validateToken` against real RS256-signed JWTs
 * (jwks-rsa mocked via the shared helper). The expected audience(s) are passed
 * per call site via an options object; with no options, a config-derived default
 * set applies.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

// Shared JWKS mock + key (side-effect import BEFORE auth is imported).
import { signTestToken } from './helpers/jwt-test-keys'

// ── Config env so issuer + audiences resolve from real config ─────────────────
const KC_BASE = 'http://localhost:8080'
const REALM = 'proxy-smart'
const ISSUER = `${KC_BASE}/realms/${REALM}`
const PROXY_BASE = 'http://localhost:8445'
const ADMIN_CLIENT_ID = 'admin-ui'
const FHIR_SERVER_BASE = 'http://localhost:8081/fhir'
// SMART access-token audience = the proxy's FHIR resource base, NOT a client id.
const FHIR_BASE_AUD = `${PROXY_BASE}/proxy-smart-backend/hapi/R4`
const MCP_AUD = `${PROXY_BASE}/mcp`

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: REALM,
  KEYCLOAK_ADMIN_CLIENT_ID: ADMIN_CLIENT_ID,
  BASE_URL: PROXY_BASE,
  FHIR_SERVER_BASE,
  MCP_ENDPOINT_PATH: '/mcp',
}
const ENV_SNAPSHOT: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    ENV_SNAPSHOT[k] = process.env[k]
    process.env[k] = v
  }
})

afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = ENV_SNAPSHOT[k]!
  }
})

// ── Import the REAL auth + audience modules (NOT mocked) ──────────────────────
const { validateToken, validateAdminToken } = await import('../src/lib/auth')
const { getFhirResourceAudiences, getMcpResourceAudience } = await import('../src/lib/token-audience')

interface MintOpts {
  aud?: string | string[]
  azp?: string
}

function mintToken(opts: MintOpts = {}): string {
  return signTestToken({ iss: ISSUER, sub: 'user-1', aud: opts.aud, azp: opts.azp })
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return false
  } catch {
    return true
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateAdminToken — admin webapp client (admin-ui) accepted independently of the admin-REST service account', () => {
  // Regression: the admin WEBAPP signs in via the `admin-ui` browser client, but
  // KEYCLOAK_ADMIN_CLIENT_ID on beta/prod is `admin-service` (the backend's
  // Keycloak admin-REST service account — a DIFFERENT client). Once audience
  // enforcement became fail-closed, admin-ui user tokens were rejected at
  // /admin/* — i.e. the admin "could not log in". validateAdminToken must accept
  // the admin-ui client regardless of the service-account id, while still
  // rejecting patient-app tokens.
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.KEYCLOAK_ADMIN_CLIENT_ID
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'admin-service' // beta/prod value
    // KEYCLOAK_ADMIN_UI_CLIENT_ID unset → config defaults to 'admin-ui'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.KEYCLOAK_ADMIN_CLIENT_ID
    else process.env.KEYCLOAK_ADMIN_CLIENT_ID = saved
  })

  it('accepts an admin-ui webapp token (azp=admin-ui, admin role) even though adminClientId=admin-service', async () => {
    const token = signTestToken({
      iss: ISSUER, sub: 'admin-1', aud: 'account', azp: 'admin-ui', realmRoles: ['admin'],
    })
    const payload = await validateAdminToken(token)
    expect(payload.sub).toBe('admin-1')
  })

  it('still REJECTS a patient-facing token at admin routes (even with an admin role claim)', async () => {
    const token = signTestToken({
      iss: ISSUER, sub: 'pt-1', aud: FHIR_BASE_AUD, azp: 'patient-portal', realmRoles: ['admin'],
    })
    expect(await rejects(validateAdminToken(token))).toBe(true)
  })

  it('default audience set (no explicit audience, e.g. GET /auth/userinfo) accepts an admin-ui token', async () => {
    // /auth/userinfo calls validateToken(token) with NO audience → the default
    // set. The admin-ui webapp client must be accepted there too, independently
    // of the admin-service account id, or webapp login fails right after the
    // token exchange (the symptom: userinfo 401 on beta).
    const token = signTestToken({
      iss: ISSUER, sub: 'admin-2', aud: 'account', azp: 'admin-ui', realmRoles: ['admin'],
    })
    const payload = await validateToken(token)
    expect(payload.sub).toBe('admin-2')
  })
})

describe('validateToken — admin / MCP audience (proxy client id)', () => {
  it('accepts a token whose aud names the proxy admin client when admin audience is expected', async () => {
    const token = mintToken({ aud: ADMIN_CLIENT_ID })
    const payload = await validateToken(token, { audience: ADMIN_CLIENT_ID })
    expect(payload.sub).toBe('user-1')
  })

  it('accepts a token whose azp names the proxy admin client (aud=account) when admin audience is expected', async () => {
    // Keycloak commonly sets aud=account and azp=<client>. azp must be honoured.
    const token = mintToken({ aud: 'account', azp: ADMIN_CLIENT_ID })
    const payload = await validateToken(token, { audience: ADMIN_CLIENT_ID })
    expect(payload.sub).toBe('user-1')
  })

  it('REJECTS a patient-facing SMART app token (aud/azp = patient-portal) at an admin/MCP call site', async () => {
    const token = mintToken({ aud: 'patient-portal', azp: 'patient-portal' })
    expect(await rejects(validateToken(token, { audience: ADMIN_CLIENT_ID }))).toBe(true)
  })

  it('accepts a token whose aud names the MCP endpoint when MCP audience is expected', async () => {
    const token = mintToken({ aud: MCP_AUD })
    const payload = await validateToken(token, { audience: MCP_AUD })
    expect(payload.sub).toBe('user-1')
  })
})

describe('validateToken — FHIR / DICOMweb audience (FHIR resource base URL)', () => {
  it('accepts a SMART app token whose aud is the proxy FHIR base', async () => {
    const token = mintToken({ aud: FHIR_BASE_AUD, azp: 'patient-portal' })
    const payload = await validateToken(token, { audience: FHIR_BASE_AUD })
    expect(payload.sub).toBe('user-1')
  })

  it('REJECTS a token whose aud is NOT the proxy FHIR base', async () => {
    const token = mintToken({ aud: 'https://evil.example.com/fhir', azp: 'patient-portal' })
    expect(await rejects(validateToken(token, { audience: FHIR_BASE_AUD }))).toBe(true)
  })

  it('REJECTS an admin-client token at the FHIR call site (wrong audience class)', async () => {
    const token = mintToken({ aud: ADMIN_CLIENT_ID, azp: ADMIN_CLIENT_ID })
    expect(await rejects(validateToken(token, { audience: FHIR_BASE_AUD }))).toBe(true)
  })
})

describe('validateToken — default (config-derived) audience set, fail-closed', () => {
  it('REJECTS a cross-audience SMART token when NO audience option is passed (default enforcement)', async () => {
    // The default acceptable set is derived from config (proxy client id + FHIR
    // base + MCP endpoint). A token for an unrelated patient app matches none.
    const token = mintToken({ aud: 'patient-portal', azp: 'patient-portal' })
    expect(await rejects(validateToken(token))).toBe(true)
  })

  it('accepts a proxy-admin-client token under the default audience set', async () => {
    const token = mintToken({ aud: ADMIN_CLIENT_ID, azp: ADMIN_CLIENT_ID })
    const payload = await validateToken(token)
    expect(payload.sub).toBe('user-1')
  })

  it('accepts a FHIR-base-audienced token under the default audience set', async () => {
    const token = mintToken({ aud: FHIR_BASE_AUD })
    const payload = await validateToken(token)
    expect(payload.sub).toBe('user-1')
  })

  it('honours an array aud claim — accepted if ANY entry matches the expected audience', async () => {
    const token = mintToken({ aud: ['account', ADMIN_CLIENT_ID] })
    const payload = await validateToken(token, { audience: ADMIN_CLIENT_ID })
    expect(payload.sub).toBe('user-1')
  })
})

/**
 * Route-contract tests: validate using the EXACT audience expectations the
 * FHIR/DICOM and MCP routes pass (getFhirResourceAudiences / getMcpResourceAudience).
 * These prove the cross-audience replay is blocked at the endpoint boundary.
 */
describe('validateToken — route audience contracts', () => {
  it('FHIR/DICOM contract: accepts a FHIR-base-audienced SMART token', async () => {
    const token = mintToken({ aud: FHIR_BASE_AUD, azp: 'patient-portal' })
    const payload = await validateToken(token, { audience: getFhirResourceAudiences() })
    expect(payload.sub).toBe('user-1')
  })

  it('FHIR/DICOM contract: REJECTS a token whose aud is a patient-app client id (not the FHIR base)', async () => {
    const token = mintToken({ aud: 'patient-portal', azp: 'patient-portal' })
    expect(await rejects(validateToken(token, { audience: getFhirResourceAudiences() }))).toBe(true)
  })

  it('MCP contract: accepts a token aud=MCP endpoint', async () => {
    const token = mintToken({ aud: getMcpResourceAudience() })
    const payload = await validateToken(token, { audience: [getMcpResourceAudience(), ADMIN_CLIENT_ID] })
    expect(payload.sub).toBe('user-1')
  })

  it('MCP contract: REJECTS a patient-facing SMART app token (FHIR-base aud) at the MCP endpoint', async () => {
    const token = mintToken({ aud: FHIR_BASE_AUD, azp: 'patient-portal' })
    expect(await rejects(validateToken(token, { audience: [getMcpResourceAudience(), ADMIN_CLIENT_ID] }))).toBe(true)
  })

  it('prefix-attack guard: REJECTS aud that is a sibling of the MCP endpoint (e.g. /mcpevil)', async () => {
    const token = mintToken({ aud: `${PROXY_BASE}/mcpevil` })
    expect(await rejects(validateToken(token, { audience: getMcpResourceAudience() }))).toBe(true)
  })

  it('prefix-attack guard: REJECTS aud that prepends a lookalike to the FHIR base', async () => {
    const token = mintToken({ aud: `${PROXY_BASE}/proxy-smart-backend-evil/hapi/R4` })
    expect(await rejects(validateToken(token, { audience: getFhirResourceAudiences() }))).toBe(true)
  })
})

/**
 * The FHIR proxy passes `enforceAudience: false`. Per SMART App Launch 2.2.0 the
 * access-token format is implementation-defined and does NOT require a JWT `aud`
 * claim, so browser SMART app tokens carry aud="account" (Keycloak default), not
 * the FHIR base — see issue #355, which intentionally skips JWT-aud validation.
 * FHIR access is gated instead by issuer + the authorize-time `aud` param + SMART
 * SCOPE (enforceScopeAccess; its deny behaviour is covered exhaustively in
 * smart-access-control.test.ts). These tests prove the relaxation drops the
 * audience check ONLY (issuer/signature/expiry stay enforced) and is a no-op for
 * every caller that does not opt in.
 */
describe('validateToken — enforceAudience: false (FHIR proxy relaxation, SMART App Launch + #355)', () => {
  it('accepts a browser SMART app token whose aud is NOT the FHIR base (aud=account)', async () => {
    const token = mintToken({ aud: 'account', azp: 'aihr-portal' })
    const payload = await validateToken(token, { enforceAudience: false })
    expect(payload.sub).toBe('user-1')
  })

  it('still REJECTS a wrong-issuer token even with enforceAudience:false (relaxation drops aud, not issuer)', async () => {
    const token = signTestToken({
      iss: 'https://evil.example.com/realms/proxy-smart',
      sub: 'user-1', aud: 'account', azp: 'aihr-portal',
    })
    expect(await rejects(validateToken(token, { enforceAudience: false }))).toBe(true)
  })

  it('is a no-op for other callers: a non-matching aud is still rejected when enforceAudience is omitted', async () => {
    const token = mintToken({ aud: 'patient-portal', azp: 'patient-portal' })
    expect(await rejects(validateToken(token))).toBe(true)
  })
})
