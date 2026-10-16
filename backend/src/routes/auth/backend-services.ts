// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * private_key_jwt client authentication. The proxy is the advertised token endpoint, so it
 * validates the client's assertion against the client's registered keys, then signs its own
 * assertion for Keycloak's federated-jwt authenticator.
 */

import { createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { signProxyAssertion } from '@/lib/proxy-signing'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { TokenCache, type FetchedToken } from '@/lib/cache/token-cache'
import { jtiReplayCache } from '@/lib/cache/jti-replay-cache'
import {
  acceptedAssertionAlgorithm,
  candidateKeys,
  clearJwksCache,
  loadJwksFromUrl,
  parseJwks,
  type AssertionAlgorithm,
  type Jwk,
  type Jwks,
  type LoadedJwks,
} from '@/lib/client-jwks'

/** How a client's verification keys are registered in Keycloak. */
interface ClientRegistration {
  internalId: string
  /** The registered URL the keys come from; absent for an inline JWKS. */
  jwksUrl?: string
  inlineJwks?: Jwks
  loadedAt: number
}

export const JWT_BEARER_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Maximum JWT lifetime allowed (5 minutes per SMART STU2.2 spec) */
const MAX_JWT_LIFETIME_SECONDS = 300

/** Clock skew tolerated on `exp`; a spent jti is kept at least this long past it. */
const CLOCK_SKEW_SECONDS = 30

/** Keycloak client registrations change through the admin API, not HTTP caching; re-read each minute. */
const REGISTRATION_TTL_MS = 60_000

/** Carries the OAuth 2.0 error code and HTTP status for direct use in responses. */
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

const adminTokens = new TokenCache()
const ADMIN_TOKEN_KEY = 'admin-service'
const registrations = new TtlCache<ClientRegistration>({ ttlMs: REGISTRATION_TTL_MS, maxEntries: 5_000 })
const forcedKeyRefreshes = new TtlCache<true>({ ttlMs: REGISTRATION_TTL_MS, maxEntries: 5_000 })

/** Clear this node's jti, client and key caches (exposed for testing). */
export function clearJtiCache(): void {
  jtiReplayCache.clear()
  registrations.clear()
  forcedKeyRefreshes.clear()
  clearJwksCache()
  adminTokens.clear()
}

/** True for any grant type (client_credentials, authorization_code, refresh_token) carrying an assertion. */
export function hasClientAssertion(body: Record<string, string | undefined>): boolean {
  return body.client_assertion_type === JWT_BEARER_TYPE
    && !!body.client_assertion
}

function decodeAssertion(assertion: string): { header: jwt.JwtHeader; payload: jwt.JwtPayload } {
  const decoded = jwt.decode(assertion, { complete: true })
  if (!decoded || typeof decoded.payload === 'string') {
    throw new ClientAssertionError('invalid_client', 'client_assertion is not a valid JWT')
  }
  return { header: decoded.header, payload: decoded.payload }
}

/**
 * Validate a private_key_jwt client assertion per RFC 7523 §3 and SMART STU2.2
 * (client-confidential-asymmetric). Throws ClientAssertionError on any violation.
 */
export async function validateClientAssertion(
  assertion: string,
  bodyClientId?: string
): Promise<{ clientId: string; internalId: string }> {
  const { header, payload } = decodeAssertion(assertion)
  const { iss, sub, aud, exp, jti } = payload

  if (!iss || iss !== sub) {
    throw new ClientAssertionError('invalid_client', 'JWT iss and sub must be present and equal')
  }

  const expectedAud = `${config.baseUrl}/auth/token`
  const audList = Array.isArray(aud) ? aud : [aud]
  if (!audList.includes(expectedAud)) {
    logger.auth.warn('JWT client assertion audience mismatch', { aud, expectedAud })
    throw new ClientAssertionError('invalid_client', 'Invalid token audience')
  }

  if (!exp || exp < Date.now() / 1000 - CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError('invalid_client', 'JWT has expired')
  }

  const now = Math.floor(Date.now() / 1000)
  if (exp > now + MAX_JWT_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new ClientAssertionError('invalid_client', 'JWT exp must not be more than 5 minutes in the future')
  }

  if (!jti) {
    throw new ClientAssertionError('invalid_client', 'JWT must contain a jti claim')
  }

  const rejectReplay = () => {
    logger.auth.warn('JWT client assertion replay detected', { clientId: iss, jti })
    return new ClientAssertionError('invalid_client', 'JWT jti has already been used')
  }
  if (await jtiReplayCache.isSpent(iss, jti)) throw rejectReplay()

  if (bodyClientId && bodyClientId !== iss) {
    throw new ClientAssertionError('invalid_client', 'client_id does not match JWT iss claim')
  }

  const clientId = iss

  let registration: ClientRegistration
  try {
    registration = await getRegistration(clientId)
  } catch (err) {
    logger.auth.error('Failed to read client keys for assertion validation', { clientId, error: err })
    throw new ClientAssertionError('invalid_client', 'Client not found or has no registered JWKS')
  }

  const { jku } = header
  if (jku !== undefined && jku !== registration.jwksUrl) {
    logger.auth.warn('JWT client assertion jku does not match the registered JWKS URL', { clientId, jku })
    throw new ClientAssertionError('invalid_client', 'JWT jku does not match the JWKS URL registered for this client')
  }

  try {
    await verifySignature(assertion, header, clientId)
  } catch (err) {
    logger.auth.warn('JWT client assertion signature verification failed', { clientId, error: err })
    throw new ClientAssertionError('invalid_client', 'JWT signature verification failed')
  }

  // Only a verified assertion spends its jti; the spend is atomic across nodes.
  if (!(await jtiReplayCache.spend(iss, jti, (exp + CLOCK_SKEW_SECONDS) * 1000))) throw rejectReplay()

  return { clientId, internalId: registration.internalId }
}

/** Validate a private_key_jwt assertion and return a proxy-signed one for Keycloak's federated-jwt. */
export async function translateClientAssertion(
  assertion: string,
  bodyClientId?: string
): Promise<{ clientId: string; proxyAssertion: string }> {
  const { clientId } = await validateClientAssertion(assertion, bodyClientId)
  const proxyAssertion = signProxyAssertion(clientId)
  return { clientId, proxyAssertion }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

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

async function getRegistration(clientId: string, options: { force?: boolean } = {}): Promise<ClientRegistration> {
  if (options.force) registrations.delete(clientId)
  return registrations.getOrLoad(clientId, () => readRegistration(clientId))
}

async function readRegistration(clientId: string): Promise<ClientRegistration> {
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
  const jwksUrl = attrs['jwks.url']
  const jwksInline = attrs['jwks.string']
  const loadedAt = Date.now()

  // Respect Keycloak's use.jwks.url toggle; a bare jwks.url without an inline set is legacy but valid.
  if (jwksUrl && (attrs['use.jwks.url'] === 'true' || !jwksInline)) {
    return { internalId: client.id, jwksUrl, loadedAt }
  }
  if (jwksInline) {
    return { internalId: client.id, inlineJwks: parseJwks(jwksInline), loadedAt }
  }
  throw new Error(`Client '${clientId}' has no registered JWKS`)
}

async function loadClientKeys(clientId: string, force: boolean): Promise<LoadedJwks> {
  const registration = await getRegistration(clientId, { force })
  if (registration.jwksUrl) return loadJwksFromUrl(registration.jwksUrl, { force })
  if (registration.inlineJwks) return { jwks: registration.inlineJwks, loadedAt: registration.loadedAt }
  throw new Error(`Client '${clientId}' has no registered JWKS`)
}

/** One forced reload per client per interval, so an unknown kid cannot be used to hammer the client's JWKS URL. */
function mayForceKeyRefresh(clientId: string): boolean {
  if (forcedKeyRefreshes.has(clientId)) return false
  forcedKeyRefreshes.set(clientId, true, config.smart.jwks.refetchMinIntervalMs)
  return true
}

/** Asymmetric step 3: exactly one matching key. An unknown kid reloads a cached key set once, for rotation. */
async function resolveVerificationKey(clientId: string, kid: string, algorithm: AssertionAlgorithm): Promise<Jwk> {
  const startedAt = Date.now()
  let keys = await loadClientKeys(clientId, false)
  let candidates = candidateKeys(keys.jwks, kid, algorithm)

  if (candidates.length === 0 && keys.loadedAt < startedAt && mayForceKeyRefresh(clientId)) {
    keys = await loadClientKeys(clientId, true)
    candidates = candidateKeys(keys.jwks, kid, algorithm)
  }

  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${algorithm} key with kid '${kid}', found ${candidates.length}`)
  }
  return candidates[0]
}

async function verifySignature(token: string, header: jwt.JwtHeader, clientId: string): Promise<void> {
  if (!header.kid) throw new Error('JWT header has no kid')
  const algorithm = acceptedAssertionAlgorithm(header.alg)
  if (!algorithm) throw new Error(`Signing algorithm '${header.alg}' is not accepted for client assertions`)

  const key = await resolveVerificationKey(clientId, header.kid, algorithm)
  // Claims were validated above; only the signature is checked here.
  jwt.verify(token, createPublicKey({ key, format: 'jwk' }), {
    algorithms: [algorithm],
    clockTolerance: CLOCK_SKEW_SECONDS,
  })
}
