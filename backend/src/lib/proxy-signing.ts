// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Proxy re-signs validated client JWTs for Keycloak federated client auth; public key served at /.well-known/jwks.json.

import { generateKeyPairSync, createPublicKey, createHmac, randomBytes, randomUUID, type KeyObject } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import jwt from 'jsonwebtoken'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { isRecord, optionalString } from '@/lib/type-guards'
import type { JsonWebKeyType, JWKSResponseType } from '@/schemas'

interface ProxyKeyPair {
  privateKeyPem: string
  publicKeyPem: string
  kid: string
  jwk: JsonWebKeyType
  /** From PROXY_SIGNING_KEY_FILE or _PEM: the same on every node and across restarts. */
  persistent: boolean
}

let _keyPair: ProxyKeyPair | null = null

export const PROXY_SIGNING_ALG = 'RS256' as const

function publicJwk(publicKey: KeyObject, kid: string): JsonWebKeyType {
  const { kty, n, e } = publicKey.export({ format: 'jwk' })
  return { kty: kty ?? 'RSA', n, e, kid, use: 'sig', alg: PROXY_SIGNING_ALG }
}

export function getProxyKeyPair(): ProxyKeyPair {
  if (_keyPair) return _keyPair

  const envKey = process.env.PROXY_SIGNING_KEY_PEM
  const envKeyFile = process.env.PROXY_SIGNING_KEY_FILE
  const envKid = process.env.PROXY_SIGNING_KEY_ID || 'proxy-signing-key-1'

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

/** Proxy key only; callers merge Keycloak keys if needed. */
export function getProxyJwks(): JWKSResponseType {
  const kp = getProxyKeyPair()
  return { keys: [kp.jwk] }
}

// KC Federated Client Authentication (26.6.0): iss = IdP alias issuer, sub = federated subject, aud = realm issuer.
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

let _kcRealmIssuer: string | null = null

// With KC_HOSTNAME set, Keycloak reports the public issuer even on the internal network, so discovery wins.
export function getKcRealmIssuer(): string {
  return _kcRealmIssuer ?? `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}`
}

/** Call once at startup; on failure the internal URL stays, which is correct without KC_HOSTNAME. */
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

const ephemeralLaunchSecret = randomBytes(32).toString('hex')

/** EHR launch code secret; must match across nodes, so per-process fallback is single-node only. */
export function launchCodeSecret(): string {
  if (process.env.SMART_LAUNCH_SECRET) return process.env.SMART_LAUNCH_SECRET
  const keyPair = getProxyKeyPair()
  return keyPair.persistent
    ? createHmac('sha256', keyPair.privateKeyPem).update('proxy-smart launch codes').digest('hex')
    : ephemeralLaunchSecret
}

/** Test-only. */
export function _resetKeyPair(): void {
  _keyPair = null
}
