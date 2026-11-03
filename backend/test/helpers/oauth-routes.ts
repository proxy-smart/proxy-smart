// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { mock } from 'bun:test'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import type { ValidateTokenOptions } from '../../src/lib/auth'
import type { OAuthFlowEvent } from '../../src/lib/oauth-metrics-logger'
import { TEST_KC_BASE_URL, TEST_REALM } from './test-env'

export const TEST_ISSUER = `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`

/** An HS256 JWT from the test realm, for suites whose validateToken is mocked to decode rather than verify. */
export function signRealmToken(claims: Record<string, unknown>): string {
  return jwt.sign({ iss: TEST_ISSUER, ...claims }, 'k', { expiresIn: '5m' })
}

/** The unverified claims of a JWT; throws for anything that is not one. */
export function jwtClaims(token: string): JwtPayload {
  const claims = jwt.decode(token, { json: true })
  if (!claims) throw new Error('invalid token')
  return claims
}

/** The claims of a JWT, or a bare test user for an opaque token. */
export function claimsOrTestUser(token: string): JwtPayload {
  return jwt.decode(token, { json: true }) ?? { sub: 'test-user' }
}

export type LoggedOAuthEvent = Omit<OAuthFlowEvent, 'id' | 'timestamp'>

export interface AuthRouteMocks {
  /** Replaces @/lib/auth when given; the real validateToken stays otherwise. */
  validateToken?: (token: string, options?: ValidateTokenOptions) => Promise<JwtPayload>
  logEvent?: (event: LoggedOAuthEvent) => void
}

/** Mocks the OAuth metrics logger and the Keycloak session resolver the /auth routes call. */
export function mockAuthRouteModules({ validateToken, logEvent = () => {} }: AuthRouteMocks = {}): void {
  mock.module('@/lib/oauth-metrics-logger', () => ({
    oauthMetricsLogger: { logEvent: async (event: LoggedOAuthEvent) => logEvent(event) },
  }))
  mock.module('@/lib/kc-session-resolver', () => ({
    autoResolvePatient: async () => null,
  }))
  if (validateToken) mock.module('@/lib/auth', () => ({ validateToken }))
}
