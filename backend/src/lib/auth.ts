// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { JwtPayload } from 'jsonwebtoken'
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTVerifyOptions } from 'jose'
import { isTokenRevoked } from './revoked-tokens'
import { config } from '../config'
import { getJwksResolver } from './jwks'
import { AuthenticationError, AuthorizationError } from './admin-utils'
import { logger } from './logger'
import { isAudienceAccepted, getMcpResourceAudience } from './token-audience'
import { hasAdminAccess, type AdminAccess } from './admin-roles'
import { readKeycloakClaims } from './jwt-claims'

export interface ValidateTokenOptions {
  /** Expected aud/azp; omitted means the config-derived default set. */
  audience?: string | string[]
  /** Default true. False only where SMART app tokens carry no FHIR-base aud (checked at /authorize instead). */
  enforceAudience?: boolean
}

const ACCEPTED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']

/** Verifies signature, expiry, issuer, revocation and (fail-closed) aud/azp binding. */
export async function validateToken(token: string, options?: ValidateTokenOptions): Promise<JwtPayload> {
  try {
    logger.auth.debug('Starting token validation')
    
    let header: ReturnType<typeof decodeProtectedHeader>
    let claims: ReturnType<typeof decodeJwt>
    try {
      header = decodeProtectedHeader(token)
      claims = decodeJwt(token)
    } catch {
      logger.auth.warn('Token has invalid format')
      throw new AuthenticationError('Invalid token format')
    }

    logger.auth.debug('Token decoded successfully', {
      alg: header.alg,
      typ: header.typ,
      kid: header.kid,
      issuer: claims.iss,
      subject: claims.sub,
      audience: claims.aud
    })

    const verifyOptions: JWTVerifyOptions = { algorithms: ACCEPTED_ALGORITHMS }
    const expectedIssuer = config.keycloak.expectedIssuer
    if (expectedIssuer) {
      verifyOptions.issuer = expectedIssuer
    }

    // Audience is enforced below rather than via jwtVerify, which neither honours `azp`
    // nor prefix-matches resource-server base URLs.
    const { payload } = await jwtVerify(token, getJwksResolver(), verifyOptions)
    const verified: JwtPayload = payload
    logger.auth.debug('Token verified successfully')

    if (isTokenRevoked(verified.jti)) {
      logger.auth.warn('Token rejected: revoked', { jti: verified.jti })
      throw new AuthenticationError('Token has been revoked')
    }

    if (options?.enforceAudience !== false) {
      const expectedAudience = options?.audience ?? process.env.JWT_EXPECTED_AUDIENCE ?? undefined
      if (!isAudienceAccepted(verified.aud, payload.azp, expectedAudience)) {
        logger.auth.warn('Token rejected — audience not accepted', {
          aud: verified.aud,
          azp: payload.azp,
          expectedAudience,
        })
        throw new AuthenticationError('Token audience is not accepted by this resource')
      }
    }

    return verified
  } catch (error) {
    logger.auth.error('Token validation failed', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType: error instanceof Error ? error.constructor.name : 'Unknown'
    })
    
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthenticationError('Token has expired')
    } else if (error instanceof joseErrors.JWTClaimValidationFailed && error.claim === 'nbf') {
      throw new AuthenticationError('Token not yet valid')
    } else if (error instanceof joseErrors.JOSEError) {
      throw new AuthenticationError(`Invalid token: ${error.message}`)
    } else if (error instanceof AuthenticationError) {
      throw error
    } else {
      throw new AuthenticationError(`Token validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}

/** Validates the token, then requires an admin role ('read' also admits auditors). */
export async function validateAdminToken(token: string, access: AdminAccess = 'write'): Promise<JwtPayload> {
  // MCP resource is accepted too: MCP spec requires RFC 8707 tokens audienced to /mcp, which shares this resource server.
  const adminAudiences = [
    config.keycloak.adminUiClientId,
    config.keycloak.adminClientId,
    getMcpResourceAudience(),
  ].filter((v): v is string => !!v)
  const payload = adminAudiences.length
    ? await validateToken(token, { audience: adminAudiences })
    : await validateToken(token)
  if (!hasAdminAccess(readKeycloakClaims(payload), access)) {
    throw new AuthorizationError('User does not have admin permissions')
  }

  return payload
}
