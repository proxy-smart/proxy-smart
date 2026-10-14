// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** BASE64URL of a SHA-256 digest is always 43 characters (RFC 7636 §4.2). */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/**
 * SMART: servers SHALL support `S256` and SHALL NOT support `plain`. A missing method means
 * `plain` (RFC 7636 §4.3), so it is refused too. Returns why the request fails, or null.
 */
export function pkceIssue(params: { code_challenge?: string; code_challenge_method?: string }): string | null {
  if (!params.code_challenge) return 'code_challenge is required: SMART apps use PKCE with S256'
  if (params.code_challenge_method !== 'S256') return 'code_challenge_method must be S256; plain is not supported'
  if (!S256_CHALLENGE.test(params.code_challenge)) return 'code_challenge must be the BASE64URL-encoded SHA-256 of the code_verifier'
  return null
}
