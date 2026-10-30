// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Registration access tokens for the RFC 7592 client configuration endpoint.
 *
 * RFC 7591 registration returns a `registration_access_token`; the client presents it as a
 * bearer token to read or delete its own registration. It is a credential for exactly one
 * client, so it is stored the way a credential should be: only a SHA-256 hash is persisted on
 * the Keycloak client, and the plaintext is returned once at registration and never again.
 * Losing it means the client can no longer manage itself — which RFC 7592 accepts, and which is
 * the right trade against keeping a recoverable secret on every client record.
 *
 * The token deliberately does NOT expire. RFC 7592 §2: "the registration access token SHOULD
 * NOT expire while a client is still actively registered", so that a developer cannot be locked
 * out of managing their own client.
 */

import * as crypto from 'crypto'
import { sha256 } from './hash'

/** Attribute holding the SHA-256 of the registration access token, hex-encoded. */
export const REGISTRATION_TOKEN_ATTRIBUTE = 'registration.access_token_sha256'

/** 256 bits of entropy, URL-safe — this is a bearer credential, not an identifier. */
export function generateRegistrationAccessToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashRegistrationAccessToken(token: string): string {
  return sha256(token)
}

/**
 * Whether a presented token matches the stored hash.
 *
 * Compared with `timingSafeEqual` over the hashes. Both sides are fixed-length hex digests, so
 * the length check below only rejects a malformed or absent stored value rather than leaking
 * anything about the token itself.
 */
export function registrationTokenMatches(presented: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false
  const expected = Buffer.from(storedHash, 'hex')
  const actual = Buffer.from(hashRegistrationAccessToken(presented), 'hex')
  if (expected.length !== actual.length || expected.length === 0) return false
  return crypto.timingSafeEqual(expected, actual)
}

/** The bearer token from an Authorization header, or undefined when absent or not Bearer. */
export function bearerToken(headers: Record<string, string | undefined>): string | undefined {
  const header = headers.authorization ?? headers.Authorization
  if (!header) return undefined
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : undefined
}
