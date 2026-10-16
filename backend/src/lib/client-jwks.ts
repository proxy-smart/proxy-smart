// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { cacheLifetimeMs } from '@/lib/http-caching'
import { validateExternalUrl } from '@/lib/url-validation'
import { isRecord } from '@/lib/type-guards'

export interface Jwk {
  kty: string
  kid?: string
  alg?: string
  use?: string
  key_ops?: string[]
  crv?: string
  [member: string]: unknown
}

export interface Jwks { keys: Jwk[] }

/** A key set together with the moment it was read, so callers can tell a stale set from a fresh one. */
export interface LoadedJwks { jwks: Jwks; loadedAt: number }

interface KeyFamily { kty: 'RSA' | 'EC'; crv?: string }

const KEY_FAMILIES = {
  RS256: { kty: 'RSA' },
  RS384: { kty: 'RSA' },
  RS512: { kty: 'RSA' },
  PS256: { kty: 'RSA' },
  PS384: { kty: 'RSA' },
  PS512: { kty: 'RSA' },
  ES256: { kty: 'EC', crv: 'P-256' },
  ES384: { kty: 'EC', crv: 'P-384' },
  ES512: { kty: 'EC', crv: 'P-521' },
} satisfies Record<string, KeyFamily>

export type AssertionAlgorithm = keyof typeof KEY_FAMILIES

function isAsymmetricAlgorithm(alg: string): alg is AssertionAlgorithm {
  return Object.prototype.hasOwnProperty.call(KEY_FAMILIES, alg)
}

/** The configured algorithms the proxy can verify; discovery advertises only these. */
export function acceptedAssertionAlgorithms(): AssertionAlgorithm[] {
  return config.smart.clientAssertionAlgorithms.filter(isAsymmetricAlgorithm)
}

/** The header alg, when it is asymmetric and configured as acceptable for client assertions. */
export function acceptedAssertionAlgorithm(alg: string | undefined): AssertionAlgorithm | null {
  if (!alg || !isAsymmetricAlgorithm(alg)) return null
  return config.smart.clientAssertionAlgorithms.includes(alg) ? alg : null
}

function isJwk(value: unknown): value is Jwk {
  return isRecord(value) && typeof value.kty === 'string'
}

export function isJwks(value: unknown): value is Jwks {
  return isRecord(value) && Array.isArray(value.keys) && value.keys.every(isJwk)
}

export function parseJwks(text: string): Jwks {
  const parsed: unknown = JSON.parse(text)
  if (!isJwks(parsed)) throw new Error('Not a JWK Set: expected an object with a keys array of JWKs')
  return parsed
}

function usableForSignatures(key: Jwk, alg: AssertionAlgorithm): boolean {
  const family: KeyFamily = KEY_FAMILIES[alg]
  if (key.kty !== family.kty) return false
  if (family.crv && key.crv !== undefined && key.crv !== family.crv) return false
  if (key.alg !== undefined && key.alg !== alg) return false
  if (key.use !== undefined && key.use !== 'sig') return false
  return key.key_ops === undefined || key.key_ops.includes('verify')
}

/**
 * SMART asymmetric authentication, step 3: every key whose kid matches and whose type fits the
 * algorithm. Verification may proceed only when exactly one remains.
 */
export function candidateKeys(jwks: Jwks, kid: string, alg: AssertionAlgorithm): Jwk[] {
  return jwks.keys.filter((key) => key.kid === kid && usableForSignatures(key, alg))
}

interface FetchedJwks extends LoadedJwks { ttlMs: number }

const fetchedJwks = new TtlCache<FetchedJwks>({ ttlMs: 0, maxEntries: 1_000 })

/**
 * Fetch a client's JWKS. The URL was SSRF-checked at registration; it is checked again here, and
 * redirects are refused because a redirect target would bypass that check.
 */
async function fetchJwks(jwksUrl: string): Promise<FetchedJwks> {
  const urlCheck = validateExternalUrl(jwksUrl, process.env.NODE_ENV === 'development')
  if (!urlCheck.valid) {
    logger.auth.warn('Blocked SSRF-suspect jwks_uri fetch', { jwksUrl, reason: urlCheck.reason })
    throw new Error(`Refusing to fetch jwks_uri '${jwksUrl}': ${urlCheck.reason}`)
  }

  const response = await fetch(jwksUrl, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(config.smart.jwks.fetchTimeoutMs),
  })
  if (!response.ok) throw new Error(`Failed to fetch JWKS from ${jwksUrl}: HTTP ${response.status}`)

  const jwks = parseJwks(await response.text())
  const ttlMs = cacheLifetimeMs(
    response.headers.get('cache-control'),
    config.smart.jwks.defaultCacheTtlMs,
    config.smart.jwks.maxCacheTtlMs,
  )
  return { jwks, loadedAt: Date.now(), ttlMs }
}

/** A client's JWKS by URL, cached no longer than its Cache-Control allows. `force` skips the cache. */
export async function loadJwksFromUrl(jwksUrl: string, options: { force?: boolean } = {}): Promise<LoadedJwks> {
  if (options.force) fetchedJwks.delete(jwksUrl)
  return fetchedJwks.getOrLoad(jwksUrl, () => fetchJwks(jwksUrl), (loaded) => loaded.ttlMs)
}

export function clearJwksCache(): void {
  fetchedJwks.clear()
}
