/**
 * Shared JWT test keys + JWKS mock.
 *
 * Generates ONE RSA keypair for the whole test process and mocks `jwks-rsa`
 * so the real `validateToken` verifies signatures against the matching public
 * key (no real Keycloak/JWKS needed). Using a single shared module avoids
 * conflicting `jwks-rsa` mocks across test files (bun applies `mock.module`
 * process-globally, so the last keypair would otherwise win).
 *
 * Import this module for its side effect BEFORE importing `../../src/lib/auth`,
 * then use {@link signTestToken} to mint RS256 tokens the real auth code accepts.
 */

import { mock } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import jwt, { type SignOptions } from 'jsonwebtoken'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

export const TEST_PUBLIC_KEY = publicKey
export const TEST_PRIVATE_KEY = privateKey
export const TEST_KEY_ID = 'test-key'

// Mock jwks-rsa: every getSigningKey call returns our shared public key.
mock.module('jwks-rsa', () => {
  const factory = () => ({
    getSigningKey: async () => ({
      getPublicKey: () => publicKey,
      publicKey,
    }),
  })
  return { default: factory }
})

export interface SignTokenOptions {
  iss?: string
  sub?: string
  aud?: string | string[]
  azp?: string
  realmRoles?: string[]
  clientRoles?: Record<string, string[]>
  /** Extra top-level claims merged into the payload. */
  extra?: Record<string, unknown>
  /** Override expiry (default 5m). Use a negative value to mint an expired token. */
  expiresIn?: SignOptions['expiresIn']
  email?: string
  preferred_username?: string
}

/** Sign an RS256 JWT that the real validateToken (with jwks mocked) will verify. */
export function signTestToken(opts: SignTokenOptions = {}): string {
  const payload: Record<string, unknown> = {
    sub: opts.sub ?? 'test-user',
    realm_access: { roles: opts.realmRoles ?? [] },
    resource_access: opts.clientRoles
      ? Object.fromEntries(Object.entries(opts.clientRoles).map(([k, roles]) => [k, { roles }]))
      : {},
    ...(opts.extra ?? {}),
  }
  if (opts.iss !== undefined) payload.iss = opts.iss
  if (opts.aud !== undefined) payload.aud = opts.aud
  if (opts.azp !== undefined) payload.azp = opts.azp
  if (opts.email !== undefined) payload.email = opts.email
  if (opts.preferred_username !== undefined) payload.preferred_username = opts.preferred_username

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: TEST_KEY_ID,
    expiresIn: opts.expiresIn ?? '5m',
  })
}
