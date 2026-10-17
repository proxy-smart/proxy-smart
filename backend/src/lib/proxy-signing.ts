// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Proxy Signing Key Infrastructure
 *
 * Manages an RSA keypair for the proxy to sign federated client assertions.
 * The proxy validates incoming client JWTs, then re-signs a new assertion
 * with its own key before forwarding to Keycloak's federated client auth.
 *
 * Key lifecycle:
 *   - Auto-generated at startup (ephemeral, dev-friendly)
 *   - Override via PROXY_SIGNING_KEY_FILE (path to PEM) or PROXY_SIGNING_KEY_PEM (inline PEM)
 *   - Public key exposed at /.well-known/jwks.json for KC to fetch
 *
 * Audience resolution:
 *   When KC_HOSTNAME is configured, Keycloak rewrites its realm issuer URL to
 *   the public hostname — even for requests arriving via the internal Docker
 *   network.  The proxy therefore fetches KC's OIDC discovery endpoint once
 *   at startup to obtain the canonical realm issuer URL and uses that as the
 *   `aud` claim in proxy-signed assertions.
 */

import { generateKeyPairSync, createPublicKey, createHmac, randomBytes, randomUUID, type KeyObject } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import jwt from 'jsonwebtoken'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { isRecord, optionalString } from '@/lib/type-guards'
import type { JsonWebKeyType, JWKSResponseType } from '@/schemas'

// ─── Key Material ───────────────────────────────────────────────────────────

interface ProxyKeyPair {
  privateKeyPem: string
  publicKeyPem: string
  kid: string
  jwk: JsonWebKeyType
  /** From PROXY_SIGNING_KEY_FILE or _PEM: the same on every node and across restarts. */
  persistent: boolean
}

let _keyPair: ProxyKeyPair | null = null

/** The algorithm used for proxy-signed assertions */
export const PROXY_SIGNING_ALG = 'RS256' as const

function publicJwk(publicKey: KeyObject, kid: string): JsonWebKeyType {
  const { kty, n, e } = publicKey.export({ format: 'jwk' })
  return { kty: kty ?? 'RSA', n, e, kid, use: 'sig', alg: PROXY_SIGNING_ALG }
}

/**
 * Initialize or return the proxy signing key pair.
 *
 * Thread-safe: if called concurrently before init completes,
 * only one keypair is generated.
 */
export function getProxyKeyPair(): ProxyKeyPair {
  if (_keyPair) return _keyPair

  const envKey = process.env.PROXY_SIGNING_KEY_PEM
  const envKeyFile = process.env.PROXY_SIGNING_KEY_FILE
  const envKid = process.env.PROXY_SIGNING_KEY_ID || 'proxy-signing-key-1'

  // Resolve PEM: file path takes precedence over inline PEM
  let resolvedPem: string | undefined
  if (envKeyFile) {
    if (!existsSync(envKeyFile)) {
      throw new Error(`PROXY_SIGNING_KEY_FILE not found: ${envKeyFile}`)
    }
    resolvedPem = readFileSync(envKeyFile, 'utf-8').trim()
    logger.server.info('Using proxy signing key from PROXY_SIGNING_KEY_FILE', { kid: envKid, path: envKeyFile })
  } else if (envKey) {
    resolvedPem = envKey
    logger.server.info('Using proxy signing key from PROXY_SIGNING_KEY_PEM env var', { kid: envKid })
  }

  if (resolvedPem) {
    const publicKeyObject = createPublicKey(resolvedPem)
    _keyPair = {
      privateKeyPem: resolvedPem,
      publicKeyPem: publicKeyObject.export({ type: 'spki', format: 'pem' }).toString(),
      kid: envKid,
      jwk: publicJwk(publicKeyObject, envKid),
      persistent: true,
    }
  } else {
    const message = 'Generating an ephemeral proxy signing key: each backend node signs with its own, so run one node or set PROXY_SIGNING_KEY_FILE or PROXY_SIGNING_KEY_PEM'
    if (process.env.NODE_ENV === 'production') logger.server.warn(message)
    else logger.server.info(message)
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const publicKeyObject = createPublicKey(publicKey)
    _keyPair = {
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
      kid: envKid,
      jwk: publicJwk(publicKeyObject, envKid),
      persistent: false,
    }
  }

  return _keyPair
}

/**
 * Return the proxy's public JWKS (for exposure at /.well-known/jwks.json).
 * Contains only the proxy's signing key — callers merge with KC keys if needed.
 */
export function getProxyJwks(): JWKSResponseType {
  const kp = getProxyKeyPair()
  return { keys: [kp.jwk] }
}

/**
 * Sign a new federated client assertion on behalf of a client.
 *
 * The proxy acts as the assertion issuer. Keycloak's federated client auth
 * validates this JWT against the proxy's JWKS.
 *
 * Claims per KC Federated Client Authentication (26.6.0):
 *   iss = proxy issuer URL (matches the OIDC IdP alias issuer in KC)
 *   sub = clientId (matches the "federated subject" configured on the KC client)
 *   aud = Keycloak realm issuer URL (required by KC — must match KC_HOSTNAME if set)
 *   exp = now + 60s (short-lived)
 *   jti = fresh UUID
 *   iat = now
 */
export function signProxyAssertion(clientId: string): string {
  const kp = getProxyKeyPair()
  const now = Math.floor(Date.now() / 1000)

  const payload = {
    iss: config.baseUrl,
    sub: clientId,
    aud: getKcRealmIssuer(),
    exp: now + 60,
    iat: now,
    jti: randomUUID(),
  }

  return jwt.sign(payload, kp.privateKeyPem, {
    algorithm: PROXY_SIGNING_ALG,
    header: {
      alg: PROXY_SIGNING_ALG,
      kid: kp.kid,
      typ: 'JWT',
    },
  })
}

// ─── KC Realm Issuer Resolution ─────────────────────────────────────────────

let _kcRealmIssuer: string | null = null

/**
 * Return the canonical KC realm issuer URL.
 *
 * When KC_HOSTNAME is configured on Keycloak, the realm issuer is the public
 * URL (e.g. `https://beta.proxy-smart.com/auth/realms/proxy-smart`) even for
 * requests arriving over the internal Docker network.  We discover the
 * correct value from KC's OIDC discovery endpoint at startup and cache it.
 *
 * Falls back to constructing the URL from `config.keycloak.baseUrl` if
 * discovery hasn't been performed yet (synchronous fallback).
 */
export function getKcRealmIssuer(): string {
  return _kcRealmIssuer ?? `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}`
}

/**
 * Fetch the KC realm issuer from OIDC discovery and cache it.
 *
 * Call this once during server startup.  If the fetch fails the proxy falls
 * back to the internal URL which works when KC_HOSTNAME is not set.
 */
export async function resolveKcRealmIssuer(): Promise<void> {
  const discoveryUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/.well-known/openid-configuration`
  try {
    const resp = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5_000) })
    if (!resp.ok) {
      logger.server.warn('KC OIDC discovery failed, using internal URL for realm issuer', {
        status: resp.status,
        url: discoveryUrl,
      })
      return
    }
    const data: unknown = await resp.json()
    const issuer = isRecord(data) ? optionalString(data.issuer) : undefined
    if (issuer) {
      _kcRealmIssuer = issuer
      logger.server.info('Resolved KC realm issuer from OIDC discovery', { issuer: _kcRealmIssuer })
    }
  } catch (err) {
    logger.server.warn('KC OIDC discovery unreachable, using internal URL for realm issuer', {
      url: discoveryUrl,
      error: err,
    })
  }
}

/** Reset key pair (for testing only). */
const ephemeralLaunchSecret = randomBytes(32).toString('hex')

/**
 * Secret that signs EHR launch codes, which any node may redeem: SMART_LAUNCH_SECRET, else derived
 * from a persistent signing key, else per process (single node only).
 */
export function launchCodeSecret(): string {
  if (process.env.SMART_LAUNCH_SECRET) return process.env.SMART_LAUNCH_SECRET
  const keyPair = getProxyKeyPair()
  return keyPair.persistent
    ? createHmac('sha256', keyPair.privateKeyPem).update('proxy-smart launch codes').digest('hex')
    : ephemeralLaunchSecret
}

export function _resetKeyPair(): void {
  _keyPair = null
}
