#!/usr/bin/env node
/**
 * Deployment enforcement probe: asserts what belongs to a deployment's configuration rather than
 * to the build, and writes nothing. The probe client holds no FHIR scope, so it can read nothing
 * even when a check regresses.
 */
import { createSign, createPrivateKey, randomUUID } from 'crypto'
import { appendFileSync } from 'fs'

const {
  BACKEND_URL, FHIR_URL, KC_URL, KC_REALM, PROBE_STAGE,
  PROBE_CLIENT_ID, PROBE_PATIENT_ID, PROBE_PRIVATE_KEY, PROBE_KID, PROBE_AUDIENCE_BINDING,
  GITHUB_STEP_SUMMARY,
} = process.env

const failures = []
const passes = []
const pass = (m) => { console.log(`  PASS: ${m}`); passes.push(m) }
const fail = (m) => { console.log(`::error::${m}`); failures.push(m) }
const timeout = (ms) => AbortSignal.timeout(ms)
const probeRead = (token) => fetch(`${FHIR_URL}/Patient/${PROBE_PATIENT_ID}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
  signal: timeout(30_000),
})

function clientAssertion() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const signingInput = [
    b64({ alg: 'RS384', typ: 'JWT', kid: PROBE_KID }),
    b64({ iss: PROBE_CLIENT_ID, sub: PROBE_CLIENT_ID, aud: `${BACKEND_URL}/auth/token`, jti: randomUUID(), iat: now, exp: now + 300 }),
  ].join('.')
  const sig = createSign('RSA-SHA384').update(signingInput).sign(createPrivateKey(PROBE_PRIVATE_KEY)).toString('base64url')
  return `${signingInput}.${sig}`
}

/** client_credentials with no scope, so the token grants no FHIR access; `resource` binds it (RFC 8707). */
async function tokenFor(resource) {
  const res = await fetch(`${BACKEND_URL}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion(),
      ...(resource && { resource }),
    }),
    signal: timeout(30_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.access_token) throw new Error(`no token${resource ? ` for ${resource}` : ''} (${res.status} ${body.error_description || body.error || ''})`)
  return body.access_token
}

async function check(name, run) {
  try {
    await run()
  } catch (e) {
    fail(`${name}: ${e.message}`)
  }
}

await check('metadata', async () => {
  const r = await fetch(`${FHIR_URL}/metadata`, { signal: timeout(30_000) })
  const body = await r.json().catch(() => ({}))
  if (r.status === 200 && body.resourceType === 'CapabilityStatement') pass('/metadata returned a CapabilityStatement')
  else fail(`/metadata returned HTTP ${r.status} (expected 200 CapabilityStatement)`)
})

// Keycloak derives scheme and port from the request unless KC_HOSTNAME pins them; a wrong iss breaks every client.
await check('issuer', async () => {
  const r = await fetch(`${KC_URL}/realms/${KC_REALM}/.well-known/openid-configuration`, { signal: timeout(30_000) })
  const { issuer } = await r.json()
  const expected = `${KC_URL}/realms/${KC_REALM}`
  if (issuer === expected) pass(`issuer is ${issuer}`)
  else fail(`issuer is '${issuer}', expected '${expected}'`)
})

await check('unauthenticated read', async () => {
  const r = await probeRead(null)
  if (r.status === 401 || r.status === 403) pass(`unauthenticated read returned ${r.status}`)
  else fail(`unauthenticated read returned ${r.status} (expected 401/403)`)
})

// The patient is never created, and consent is evaluated before anything is proxied upstream. audit-only
// would let the request through to the scope check instead, which refuses with a different error.
await check('consent enforcement', async () => {
  const r = await probeRead(await tokenFor())
  const body = await r.json().catch(() => ({}))
  if (r.status === 403 && ['consent_denied', 'ial_verification_failed'].includes(body.error)) {
    pass(`access without consent was denied (403 ${body.error})`)
  } else if (r.status === 401) {
    fail(`the token was refused before consent was evaluated (401 ${body.error || ''}: ${body.error_description || ''}), so consent enforcement is UNVERIFIED`)
  } else {
    fail(`access without consent returned ${r.status} ${body.error || ''}, expected 403 consent_denied. Consent is NOT enforced (check CONSENT_ENABLED / CONSENT_MODE).`)
  }
})

// A token issued for the proxy's MCP endpoint is valid at the proxy but names another resource server.
if (PROBE_AUDIENCE_BINDING === 'enforce') await check('audience binding', async () => {
  const meta = await fetch(`${BACKEND_URL}/.well-known/oauth-protected-resource/mcp`, { signal: timeout(30_000) }).then((r) => r.json())
  if (!meta.resource) throw new Error('the MCP protected-resource metadata names no resource')
  const r = await probeRead(await tokenFor(meta.resource))
  const body = await r.json().catch(() => ({}))
  if (r.status === 401 && body.error === 'invalid_token') {
    pass(`a token for ${meta.resource} was refused at the FHIR endpoint (401 invalid_token)`)
  } else {
    fail(`a token for ${meta.resource} returned ${r.status} ${body.error || ''} at the FHIR endpoint, expected 401 invalid_token. Audience binding is NOT enforced (check FHIR_AUDIENCE_ENFORCEMENT).`)
  }
})

const stage = PROBE_STAGE || 'deployment'
const summary = failures.length
  ? `## Enforcement Probe (${stage}) - FAILED (${failures.length})\n\n${failures.map((f) => `- ${f}`).join('\n')}\n`
  : `## Enforcement Probe (${stage}) - PASSED\n\n${passes.map((p) => `- ${p}`).join('\n')}\n\nNothing was written.\n`

if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, summary)
console.log(`\n${summary}`)
process.exit(failures.length ? 1 : 0)
