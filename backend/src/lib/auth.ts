// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { JwtPayload } from 'jsonwebtoken'
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTVerifyOptions } from 'jose'
import { config } from '../config'
import { getJwksResolver } from './jwks'
import { AuthenticationError, AuthorizationError } from './admin-utils'
import { logger } from './logger'
import { isAudienceAccepted, getMcpResourceAudience } from './token-audience'
import { hasAdminAccess, type AdminAccess } from './admin-roles'

/** Options for {@link validateToken}. */
export interface ValidateTokenOptions {
  /**
   * Expected audience(s) for this call site. SMART on FHIR endpoints accept
   * different audiences (proxy client id for admin/MCP; FHIR resource base URL
   * for the FHIR/DICOM proxy). When omitted, a config-derived default set of
   * acceptable audiences applies. Audience is ALWAYS enforced (fail-closed)
   * unless the `JWT_AUDIENCE_ENFORCEMENT=disabled` escape hatch is set, or
   * `enforceAudience` is explicitly false for this call site.
   */
  audience?: string | string[]
  /**
   * Whether to enforce the JWT `aud`/`azp` audience binding for this call site.
   * Defaults to `true` (fail-closed). Set to `false` only for the FHIR proxy:
   * per SMART App Launch 2.2.0 the access-token format is implementation-defined
   * and does NOT require a JWT `aud` claim, so SMART app tokens never carry the
   * FHIR base as `aud`. The anti-leakage guarantee for FHIR is instead met by the
   * `aud`/`resource` REQUEST parameter validated at /authorize (issue #355
   * Phase 2), while issuer/signature/expiry verification and SMART scope
   * enforcement remain the gates. This flag is a no-op for callers that omit it.
   * "The FHIR proxy" is the call site's job, not its path: the per-server FHIR MCP
   * endpoint serves those same tools and shares the policy. The admin MCP endpoint,
   * which administers the deployment rather than reading it, keeps audience enforced.
   */
  enforceAudience?: boolean
}

/** Keycloak-specific JWT payload with realm/resource access claims */
export interface KeycloakJwtPayload extends JwtPayload {
  realm_access?: { roles: string[] }
  resource_access?: Record<string, { roles: string[] }>
  preferred_username?: string
  email?: string
  name?: string
}

const ACCEPTED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']

/**
 * Validates a JWT token using Keycloak's public keys.
 * Verifies signature, expiry, and issuer (iss).
 *
 * Audience binding: in addition to signature/expiry/issuer, the token's
 * `aud`/`azp` is bound to an acceptable audience (fail-closed). Call sites pass
 * their expected audience via {@link ValidateTokenOptions}; when omitted, a
 * config-derived default set applies. This prevents cross-audience token replay
 * (e.g. a patient-facing SMART app token being accepted at /mcp or admin routes).
 *
 * @param token JWT token to validate
 * @param options Optional audience expectations (see {@link ValidateTokenOptions})
 * @returns Decoded token payload
 * @throws AuthenticationError for invalid/expired tokens or audience mismatch
 */
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

    // Audience binding (fail-closed by default). A call site MAY opt out by
    // passing `enforceAudience: false` (FHIR proxy only — see ValidateTokenOptions
    // and issue #355). Issuer/signature/expiry above are verified regardless, so
    // opting out never weakens those guarantees.
    if (options?.enforceAudience !== false) {
      // Determine the expected audience(s):
      //  - explicit per-call-site audience (options.audience), else
      //  - the legacy JWT_EXPECTED_AUDIENCE env var (back-compat), else
      //  - the config-derived default acceptable-audience set.
      const expectedAudience = options?.audience ?? process.env.JWT_EXPECTED_AUDIENCE ?? undefined
      if (!isAudienceAccepted(verified.aud, (verified as Record<string, unknown>).azp, expectedAudience)) {
        logger.auth.warn('Token rejected — audience not accepted', {
          aud: verified.aud,
          azp: (verified as Record<string, unknown>).azp,
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
      // For any other errors (e.g., JWKS fetch errors), throw as authentication error
      throw new AuthenticationError(`Token validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}

/**
 * Validates a JWT token AND checks that the user has admin roles.
 * Use this for sensitive operations that require elevated privileges.
 *
 * @param token JWT token to validate
 * @param access 'read' also admits the auditor role; 'write', the default, admits administrators only
 * @returns Decoded token payload (guaranteed to have admin roles)
 * @throws AuthenticationError for invalid tokens or missing admin roles
 */
export async function validateAdminToken(token: string, access: AdminAccess = 'write'): Promise<JwtPayload> {
  // Admin tokens are bound to the proxy's own client audience, NOT a FHIR
  // resource base, so an FHIR-base-audienced (patient-app) token can never reach
  // admin operations. Two proxy clients legitimately produce admin tokens:
  //   - admin-ui      : the browser client the admin WEBAPP signs in with
  //                     (config.keycloak.adminUiClientId) — what real users use.
  //   - admin-service : the backend's Keycloak admin-REST service account
  //                     (config.keycloak.adminClientId).
  // Accept either (matched on aud/azp), still fail-closed. Admin ROLES are still
  // required below. NB: these were historically conflated under adminClientId,
  // which broke webapp login wherever KEYCLOAK_ADMIN_CLIENT_ID=admin-service.
  //
  // THIRD accepted audience: the MCP resource itself. The MCP endpoint generates its whole tool
  // surface from these admin routes, and an MCP client's token is audienced to the MCP resource
  // (RFC 8707) because the MCP spec REQUIRES it: "MCP servers MUST only accept tokens
  // specifically intended for themselves and MUST reject tokens that do not include them in the
  // audience claim". So a spec-conformant MCP client can never present an admin-ui-audienced
  // token, and without this every create_admin_*/update_admin_*/delete_admin_* tool answered 403
  // for every MCP client — the entire surface dead by construction.
  //
  // This is NOT the cross-resource reuse the spec forbids. The forbidden case is accepting a token
  // minted for a DIFFERENT resource; here /mcp and /admin are the same resource server, and the
  // token names it. A FHIR-base-audienced SMART app token is still refused, which is the boundary
  // that actually matters. Authority remains with ROLES, checked below and unchanged.
  const adminAudiences = [
    config.keycloak.adminUiClientId,
    config.keycloak.adminClientId,
    getMcpResourceAudience(),
  ].filter((v): v is string => !!v)
  const payload = adminAudiences.length
    ? await validateToken(token, { audience: adminAudiences })
    : await validateToken(token)
  const keycloakPayload = payload as KeycloakJwtPayload

  // Role policy lives in lib/admin-roles: one predicate, three claim locations, and the
  // admin-UI client id read from config so it cannot disagree with the audience check above.
  if (!hasAdminAccess(keycloakPayload, access)) {
    // AuthorizationError, not AuthenticationError: the token is authentic and correctly
    // audienced, the USER just lacks a role. The caller reports these differently.
    throw new AuthorizationError('User does not have admin permissions')
  }

  return payload
}
