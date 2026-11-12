// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import * as crypto from 'crypto'
import { isRecord, optionalString, parseJson } from '@/lib/type-guards'

export class KeyMaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyMaterialError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface KeyMaterial {
  jwksUri?: string
  jwksString?: string
  publicKeyPem?: string
  signingAlg?: string
}

function pemToJwk(pem: string) {
  try {
    return crypto.createPublicKey(pem).export({ format: 'jwk' })
  } catch {
    throw new KeyMaterialError('publicKey must be a PEM-encoded public key')
  }
}

/** An inline JWKS as given, or a PEM key converted to one; the alg is stated, else read from the first key, else RS384. */
export function inlineJwks(options: KeyMaterial): { jwks: string; alg: string } | undefined {
  if (options.jwksString) {
    const parsed = parseJson(options.jwksString)
    if (!isRecord(parsed) || !Array.isArray(parsed.keys)) throw new KeyMaterialError('jwksString must be a JWKS: a JSON object with a keys array')
    const firstKey = parsed.keys[0]
    const detected = isRecord(firstKey) ? optionalString(firstKey.alg) : undefined
    return { jwks: options.jwksString, alg: options.signingAlg || detected || 'RS384' }
  }
  if (options.publicKeyPem) {
    const alg = options.signingAlg || 'RS384'
    const jwk = pemToJwk(options.publicKeyPem)
    return { jwks: JSON.stringify({ keys: [{ ...jwk, use: 'sig', alg, kid: crypto.randomUUID() }] }), alg }
  }
  return undefined
}

/** The attributes that make the given key material the one Keycloak verifies with; a jwksUri wins, as on create. */
export function keyMaterialAttributes(options: KeyMaterial): Record<string, string> | undefined {
  if (options.jwksUri) {
    return {
      'use.jwks.url': 'true',
      'jwks.url': options.jwksUri,
      'use.jwks.string': 'false',
      'token.endpoint.auth.signing.alg': options.signingAlg || 'RS384',
    }
  }
  const inline = inlineJwks(options)
  if (!inline) return undefined
  return {
    'use.jwks.string': 'true',
    'jwks.string': inline.jwks,
    'use.jwks.url': 'false',
    'token.endpoint.auth.signing.alg': inline.alg,
  }
}
