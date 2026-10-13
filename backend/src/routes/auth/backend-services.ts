// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Client Assertion Validation & Federated Authentication
 *
 * Our proxy IS the token endpoint advertised in .well-known/smart-configuration.
 * Clients send JWT assertions with aud = our proxy's token URL.
 *
 * Solution: validate the JWT assertion at the proxy layer, then re-sign a new
 * assertion with the proxy's own signing key for Keycloak's federated client auth.
 *
 * Flow (all grant types with private_key_jwt):
 *   1. Decode & validate the client's JWT assertion (aud, iss, sub, exp, jti)
 *   2. Fetch the client's registered public JWKS from Keycloak admin API
 *   3. Verify the JWT signature against the JWKS
 *   4. Sign a new assertion with the proxy's key (iss=proxy, sub=clientId, aud=KC)
 *   5. Forward the proxy-signed assertion to Keycloak for token issuance
 */

import { createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'
import fetch from 'cross-fetch'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { signProxyAssertion } from '@/lib/proxy-signing'
import { validateExternalUrl } from '@/lib/url-validation'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { TokenCache, type FetchedToken } from '@/lib/cache/token-cache'
import { jtiReplayCache } from '@/lib/cache/jti-replay-cache'

/** A JSON Web Key with required kty and optional kid, plus any additional JWK fields */
interface JwkKey { kty: string; kid?: string; [key: string]: unknown }

/** Metadata returned by the client lookup helper */
interface ClientMetadata {
  jwks: { keys: JwkKey[] }
  internalId: string
  /** The registered URL the keys came from; absent for an inline JWKS. */
  jwksUrl?: string
}

export const JWT_BEARER_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Maximum JWT lifetime allowed (5 minutes per SMART STU2.2 spec) */
const MAX_JWT_LIFETIME_SECONDS = 300

/** Clock skew tolerated on `exp`; a spent jti is kept at least this long past it. */
const CLOCK_SKEW_SECONDS = 30

/**
 * Structured error thrown by validateClientAssertion.
 * Carries the OAuth 2.0 error code and HTTP status for direct use in responses.
 */
export class ClientAssertionError extends Error {
  constructor(
    readonly oauthError: string,
    readonly description: string,
    readonly httpStatus: number = 400
  ) {
    super(description)
    this.name = 'ClientAssertionError'
  }
}

/** TTL for JWKS/secret cache entries (60 seconds) */
const CACHE_TTL_MS = 60_000

/** Cached admin-service access token for Keycloak admin API calls */
const adminTokens = new TokenCache()
const ADMIN_TOKEN_KEY = 'admin-service'

/** Clear this node's jti and client caches (exposed for testing). */
export function clearJtiCache(): void {
  jtiReplayCache.clear()
  clientMetadata.clear()
  adminTokens.clear()
}

// ─── Client config cache (metadata) ────────────────────────────────────────
const clientMetadata = new TtlCache<ClientMetadata>({ ttlMs: CACHE_TTL_MS })

/**
 * Check whether a token request contains a private_key_jwt client assertion.
 * Works for any grant type (client_credentials, authorization_code, refresh_token).
 */
export function hasClientAssertion(body: Record<string, string | undefined>): boolean {
  return body.client_assertion_type === JWT_BEARER_TYPE
    && !!body.client_assertion
}

/**
 * Validate a private_key_jwt client assertion per RFC 7523 §3 and SMART STU2.2 §4.1.5.
 *
 * Checks: JWT structure, iss/sub equality, aud (proxy token endpoint), exp, jti
 * uniqueness (replay protection), optional body client_id match, and signature
 * against the client's registered JWKS in Keycloak.
 *
 * Throws ClientAssertionError on any violation.
 * Returns { clientId, internalId } on success.
 */
export async function validateClientAssertion(
  assertion: string,
  bodyClientId?: string
): Promise<{ clientId: string; internalId: string }> {
  const decoded = jwt.decode(assertion, { complete: true }) as {
    header: jwt.JwtHeader
    payload: jwt.JwtPayload
  } | null

  if (!decoded?.payload || !decoded?.header) {
    throw new ClientAssertionError('invalid_client', 'client_assertion is not a valid JWT')
  }

  const { iss, sub, aud, exp, jti } = decoded.payload

  // iss and sub MUST equal the client_id (RFC 7523 §3)
  if (!iss || iss !== sub) {
    throw new ClientAssertionError('invalid_client', 'JWT iss and sub must be present and equal')
  }

  // aud MUST include the proxy's token endpoint
  const expectedAud = `${config.baseUrl}/auth/token`
  const audList = Array.isArray(aud) ? aud : [aud]
  if (!audList.includes(expectedAud)) {
    logger.auth.warn('JWT client assertion audience mismatch', { aud, expectedAud })
    throw new ClientAssertionError('invalid_client', 'Invalid token audience')
  }

  // exp MUST be present and not expired
  if (!exp || exp < Date.now() / 1000 - CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError('invalid_client', 'JWT has expired')
  }

  // exp ceiling: MUST be ≤5 minutes in the future (SMART STU2.2 §4.1.5.1)
  const now = Math.floor(Date.now() / 1000)
  if (exp > now + MAX_JWT_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError('invalid_client', 'JWT exp must not be more than 5 minutes in the future')
  }

  // jti MUST be present and unique (SMART STU2.2 §4.1.5.2.1)
  if (!jti) {
    throw new ClientAssertionError('invalid_client', 'JWT must contain a jti claim')
  }

  const rejectReplay = () => {
    logger.auth.warn('JWT client assertion replay detected', { clientId: iss, jti })
    return new ClientAssertionError('invalid_client', 'JWT jti has already been used')
  }
  if (await jtiReplayCache.isSpent(iss, jti)) throw rejectReplay()

  // If client_id was provided in the request body, it MUST match the JWT iss
  if (bodyClientId && bodyClientId !== iss) {
    throw new ClientAssertionError('invalid_client', 'client_id does not match JWT iss claim')
  }

  const clientId = iss

  // Fetch the client's registered JWKS from Keycloak admin API
  let clientMeta: ClientMetadata
  try {
    clientMeta = await getClientMetadata(clientId)
  } catch (err) {
    logger.auth.error('Failed to fetch client JWKS for assertion validation', { clientId, error: err })
    throw new ClientAssertionError('invalid_client', 'Client not found or has no registered JWKS')
  }

  // SMART Backend Services: a jku SHALL match the JWKS URL registered for the client.
  const { jku } = decoded.header
  if (jku !== undefined && jku !== clientMeta.jwksUrl) {
    logger.auth.warn('JWT client assertion jku does not match the registered JWKS URL', { clientId, jku })
    throw new ClientAssertionError('invalid_client', 'JWT jku does not match the JWKS URL registered for this client')
  }

  // Verify JWT signature against the client's JWKS
  try {
    await verifyJwtSignature(assertion, decoded.header, clientMeta.jwks)
  } catch (err) {
    logger.auth.warn('JWT client assertion signature verification failed', { clientId, error: err })
    throw new ClientAssertionError('invalid_client', 'JWT signature verification failed')
  }

  // Only a verified assertion spends its jti; the spend is atomic across nodes.
  if (!(await jtiReplayCache.spend(iss, jti, (exp + CLOCK_SKEW_SECONDS) * 1000))) throw rejectReplay()

  return { clientId, internalId: clientMeta.internalId }
}

/**
 * Validate a private_key_jwt assertion and return a proxy-signed assertion
 * for forwarding to Keycloak's federated client authentication.
 *
 * Flow:
 *   1. Validate incoming client assertion (structure, claims, signature)
 *   2. Sign a new JWT with the proxy's key (iss=proxy, sub=clientId, aud=KC realm)
 *   3. Return the proxy assertion for the caller to forward to KC
 *
 * Throws ClientAssertionError if the incoming assertion is invalid.
 */
export async function translateClientAssertion(
  assertion: string,
  bodyClientId?: string
): Promise<{ clientId: string; proxyAssertion: string }> {
  const { clientId } = await validateClientAssertion(assertion, bodyClientId)
  const proxyAssertion = signProxyAssertion(clientId)
  return { clientId, proxyAssertion }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Get an admin-service access token (cached). */
async function getAdminToken(): Promise<string> {
  return adminTokens.get(ADMIN_TOKEN_KEY, fetchAdminToken)
}

async function fetchAdminToken(): Promise<FetchedToken> {
  const kcUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`
  const resp = await fetch(kcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.keycloak.adminClientId ?? '',
      client_secret: config.keycloak.adminClientSecret ?? '',
    }).toString()
  })

  if (!resp.ok) {
    throw new Error(`Admin token request failed: ${resp.status}`)
  }

  const data: { access_token: string; expires_in?: number } = await resp.json()
  return { token: data.access_token, expiresInSeconds: data.expires_in }
}

/**
 * Fetch client metadata from Keycloak admin API (with TTL cache).
 * Returns JWKS, internal UUID, and the client's authenticator type.
 * Uses: GET /admin/realms/{realm}/clients?clientId=X
 */
async function getClientMetadata(clientId: string): Promise<ClientMetadata> {
  return clientMetadata.getOrLoad(clientId, () => readClientMetadata(clientId))
}

async function readClientMetadata(clientId: string): Promise<ClientMetadata> {
  const adminToken = await getAdminToken()
  const searchUrl = `${config.keycloak.baseUrl}/admin/realms/${config.keycloak.realm}/clients?clientId=${encodeURIComponent(clientId)}`

  const resp = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${adminToken}` }
  })
  if (!resp.ok) {
    throw new Error(`Failed to look up client '${clientId}': ${resp.status}`)
  }

  const clients = await resp.json()
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error(`Client '${clientId}' not found in Keycloak`)
  }

  const client = clients[0]
  const attrs = client.attributes ?? {}

  // Respect Keycloak's use.jwks.url / use.jwks.string toggles.
  // When use.jwks.url=true, fetch from jwks.url even if jwks.string exists.
  const useJwksUrl = attrs['use.jwks.url'] === 'true'
  const jwksUrl = attrs['jwks.url']
  const jwksInline = attrs['jwks.string']

  // Preferred: the registered JWKS URL (supports key rotation); legacy: jwks.url without the toggle.
  const keysUrl = jwksUrl && (useJwksUrl || !jwksInline) ? jwksUrl : undefined

  if (keysUrl) {
    return { jwks: await fetchJwksUrl(keysUrl), internalId: client.id, jwksUrl: keysUrl }
  }
  if (jwksInline) {
    return { jwks: JSON.parse(jwksInline), internalId: client.id }
  }
  throw new Error(`Client '${clientId}' has no registered JWKS`)
}

/**
 * Fetch a client's JWKS from a registered jwks_uri, with SSRF protection.
 *
 * VULN 2 (HIGH) — defense-in-depth fetch layer: a client-supplied jwks_uri is
 * a server-side fetch sink. Although registration-layer validation
 * (client-registration.ts) blocks internal hosts at write time, we re-validate
 * here at read time so that any pre-existing or out-of-band stored URL pointing
 * at an internal/metadata/RFC1918/link-local host is NEVER dereferenced. The
 * guard runs BEFORE the request is issued, so no SSRF probe ever leaves the
 * process. http(s) scheme only; fail-closed.
 *
 * Mirrors the dev/docker carve-out used in fhir-servers.ts so legitimate
 * internal federation keeps working in local development; the guard is fully
 * active in test and production.
 */
async function fetchJwksUrl(jwksUrl: string): Promise<{ keys: JwkKey[] }> {
  const allowInternal = process.env.NODE_ENV === 'development'
  const urlCheck = validateExternalUrl(jwksUrl, allowInternal)
  if (!urlCheck.valid) {
    logger.auth.warn('Blocked SSRF-suspect jwks_uri fetch', { jwksUrl, reason: urlCheck.reason })
    throw new Error(`Refusing to fetch jwks_uri '${jwksUrl}': ${urlCheck.reason}`)
  }

  const jwksResp = await fetch(jwksUrl)
  if (!jwksResp.ok) throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${jwksResp.status}`)
  return jwksResp.json()
}

/**
 * Verify the JWT signature against a JWKS.
 * Finds the matching key by kid (or uses the first key), then verifies.
 * Uses crypto.createPublicKey to convert JWK → PEM directly (no network fallback).
 */
async function verifyJwtSignature(
  token: string,
  header: jwt.JwtHeader,
  jwksJson: { keys: JwkKey[] }
): Promise<void> {
  // Find the matching key by kid, or fall back to first key
  const matchingKey = header.kid
    ? jwksJson.keys.find(k => k.kid === header.kid)
    : jwksJson.keys[0]

  if (!matchingKey) {
    throw new Error(`No matching key found for kid '${header.kid}'`)
  }

  // Convert JWK to PEM public key using Node's built-in crypto
  const keyObject = createPublicKey({ key: matchingKey, format: 'jwk' })
  const publicKey = keyObject.export({ type: 'spki', format: 'pem' }) as string

  // Verify the token — only check signature, we already validated claims above
  jwt.verify(token, publicKey, {
    algorithms: [header.alg as jwt.Algorithm || 'RS256'],
    // Skip audience/issuer checks here since we already validated them
    clockTolerance: CLOCK_SKEW_SECONDS,
  })
}
