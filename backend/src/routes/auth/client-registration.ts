// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { logger } from '@/lib/logger'
import { ensureScopeMappers, SMART_SCOPE_MAPPERS } from '@/lib/smart-scope-mappers'
import { assignResourceIndicatorsScope, assignStandardOidcScopes } from '@/lib/smart-client-enrichment'
import {
  KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  STANDARD_OIDC_DEFAULT_SCOPES,
  STANDARD_OIDC_OPTIONAL_SCOPES,
} from '@/lib/oauth-scopes'
import { refreshCorsOrigins } from '@/lib/cors-origins'
import { getServiceAccountAdmin } from '@/lib/service-account-admin'
import { authEndpointRateLimit } from '@/lib/rate-limit'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import {
  REGISTRATION_TOKEN_ATTRIBUTE,
  bearerToken,
  generateRegistrationAccessToken,
  hashRegistrationAccessToken,
  registrationTokenMatches,
} from '@/lib/registration-access-token'
import * as crypto from 'crypto'
import { getClientRegistrationSettings } from '../admin/client-registration-settings'
import { ClientRegistrationRequest, ClientRegistrationResponse, CommonErrorResponses } from '@/schemas'
import { config } from '@/config'
import { checkExternalUrl } from '@proxy-smart/auth'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { isJwks } from '@/lib/client-jwks'
import { toTokenEndpointAuthMethod } from '@/lib/auth-method-mapping'
import {
  buildDcrClient,
  classifyRegistration,
  redirectUriRejection,
  registeredGrantTypes,
  usesAuthorizationCode,
} from './dcr-client'

/**
 * OAuth 2.0 Dynamic Client Registration Protocol (RFC 7591)
 * https://tools.ietf.org/html/rfc7591
 * 
 * SMART App Launch Framework requires support for dynamic client registration
 * to enable automated app onboarding.
 * 
 * This is a public endpoint that uses service account credentials to register clients,
 * since RFC 7591 requires unauthenticated registration.
 * 
 * Note: This provides the same functionality as smart-apps.ts but via a public endpoint
 * that conforms to RFC 7591 Dynamic Client Registration standard.
 */

export interface ClientRegistrationResponse {
  client_id: string
  client_secret?: string
  client_id_issued_at: number
  client_secret_expires_at?: number
  /** RFC 7592: bearer token for this client's configuration endpoint. Returned once. */
  registration_access_token?: string
  /** RFC 7592: where this client reads or deletes its own registration. */
  registration_client_uri?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  client_name?: string
  client_uri?: string
  logo_uri?: string
  scope?: string
  contacts?: string[]
  tos_uri?: string
  policy_uri?: string
  jwks_uri?: string
  jwks?: object
  token_endpoint_auth_method: string
  // SMART-specific
  fhir_versions?: string[]
  launch_uris?: string[]
}

/** An authenticated RFC 7592 request, or the error to return for it. */
type RegistrationAuth =
  | { client: ClientRepresentation; id: string }
  | { error: { error: string; error_description: string }; status: number }

/**
 * Resolve and authorise an RFC 7592 request for one client.
 *
 * Every failure returns the SAME 401, deliberately: an unknown client_id, a client that was not
 * dynamically registered, and a wrong token are indistinguishable to the caller. Otherwise this
 * endpoint becomes an oracle for enumerating which client ids exist.
 */
async function authenticateRegistration(
  clientId: string,
  headers: Record<string, string | undefined>,
): Promise<RegistrationAuth> {
  const unauthorized = {
    error: { error: 'invalid_token', error_description: 'Invalid registration access token' },
    status: 401,
  }
  const presented = bearerToken(headers)
  if (!presented) return unauthorized

  let client: ClientRepresentation | undefined
  try {
    const admin = await getServiceAccountAdmin()
    ;[client] = await admin.clients.find({ clientId })
  } catch (error) {
    logger.admin.warn('RFC 7592: client lookup failed', { clientId, error })
    return { error: { error: 'server_error', error_description: 'Lookup failed' }, status: 500 }
  }

  if (!client?.id) return unauthorized
  // Only dynamically-registered clients have a registration to manage. A first-party client
  // from realm-export must never be deletable through this path.
  if (client.attributes?.['dynamic_registration'] !== 'true') return unauthorized
  if (!registrationTokenMatches(presented, client.attributes?.[REGISTRATION_TOKEN_ATTRIBUTE])) {
    return unauthorized
  }
  return { client, id: client.id }
}

export const clientRegistrationRoutes = new Elysia({ tags: ['authentication'] })
  
  // Dynamic Client Registration - Public endpoint as required by RFC 7591
  .post('/register', async ({ body, set }) => {
    try {
      // Use service account for public registration
      const admin = await getServiceAccountAdmin()
      
      // Load admin settings for validation
      const settings = await getClientRegistrationSettings(admin)
      
      // Check if dynamic client registration is enabled
      if (!settings.enabled) {
        set.status = 403
        return {
          error: 'access_denied',
          error_description: 'Dynamic client registration is currently disabled'
        }
      }
      
      const kind = classifyRegistration(body)
      const authorizationCode = usesAuthorizationCode(body, kind)

      if (authorizationCode && body.redirect_uris.length === 0) {
        set.status = 400
        return {
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required'
        }
      }

      if (body.redirect_uris.length > settings.maxRedirectUris) {
        set.status = 400
        return {
          error: 'invalid_redirect_uri',
          error_description: `Maximum ${settings.maxRedirectUris} redirect URIs allowed`
        }
      }

      const redirectRejection = redirectUriRejection(body.redirect_uris, settings.requireHttps)
      if (redirectRejection) {
        set.status = 400
        return { error: 'invalid_redirect_uri', error_description: redirectRejection }
      }

      // Validate redirect URIs against allowed patterns
      const invalidPatterns = body.redirect_uris.filter(uri => {
        return !settings.allowedRedirectUriPatterns.some(pattern => {
          try {
            // Use linear-time matching via string comparison for simple patterns,
            // or bounded regex for complex ones. Limit input length to prevent ReDoS.
            if (uri.length > 2048) return false
            const regex = new RegExp(pattern)
            return regex.test(uri)
          } catch {
            return false // Invalid regex patterns are ignored
          }
        })
      })
      
      if (invalidPatterns.length > 0) {
        set.status = 400
        return {
          error: 'invalid_redirect_uri',
          error_description: 'One or more redirect URIs do not match allowed patterns'
        }
      }

      // Validate required fields based on settings
      if (settings.requireTermsOfService && !body.tos_uri) {
        set.status = 400
        return {
          error: 'invalid_client_metadata',
          error_description: 'Terms of service URI is required'
        }
      }

      if (settings.requirePrivacyPolicy && !body.policy_uri) {
        set.status = 400
        return {
          error: 'invalid_client_metadata',
          error_description: 'Privacy policy URI is required'
        }
      }

      // jwks_uri is fetched server-side at token time; refuse internal hosts before it is stored.
      if (body.jwks_uri) {
        const jwksUriCheck = await checkExternalUrl(body.jwks_uri, outboundUrlPolicy)
        if (!jwksUriCheck.valid) {
          logger.admin.warn('Rejected client registration with SSRF-suspect jwks_uri', {
            jwksUri: body.jwks_uri,
            reason: jwksUriCheck.reason,
          })
          set.status = 400
          return {
            error: 'invalid_client_metadata',
            error_description: `jwks_uri rejected: ${jwksUriCheck.reason}`
          }
        }
      }

      if (body.jwks && !isJwks(body.jwks)) {
        set.status = 400
        return { error: 'invalid_client_metadata', error_description: 'jwks must be a JWK Set with a keys array' }
      }

      const isConfidential = kind !== 'public'
      const isBackendService = kind === 'backend-service'

      // Check if client type is allowed
      if (!isConfidential && !settings.allowPublicClients) {
        set.status = 400
        return {
          error: 'invalid_client_metadata',
          error_description: 'Public clients are not allowed'
        }
      }
      
      if (isConfidential && !isBackendService && !settings.allowConfidentialClients) {
        set.status = 400
        return {
          error: 'invalid_client_metadata',
          error_description: 'Confidential clients are not allowed'
        }
      }
      
      if (isBackendService && !settings.allowBackendServices) {
        set.status = 400
        return {
          error: 'invalid_client_metadata',
          error_description: 'Backend service clients are not allowed'
        }
      }

      // RFC 7591 §2: the server MAY grant fewer scopes than requested, so unsupported ones are dropped.
      const grantedScope = body.scope
        ?.split(' ')
        .filter(scope => settings.allowedScopes.includes(scope))
        .join(' ') || undefined

      const clientId = `smart_app_${crypto.randomUUID()}`
      // RFC 7592: the credential the client will use to read or delete its own registration.
      // Generated before the client so its hash can go in with the initial attributes.
      const registrationAccessToken = generateRegistrationAccessToken()

      const now = Date.now()
      const { representation } = buildDcrClient({
        clientId,
        body,
        settings,
        registrationTokenHash: hashRegistrationAccessToken(registrationAccessToken),
        now,
      })
      const createdClient = await admin.clients.create(representation)

      if (createdClient.id) {
        try {
          const allClientScopes = await admin.clientScopes.find()

          // The baseline every client needs regardless of what it registered with: Keycloak's
          // silent claim scopes (roles / web-origins / acr) plus the standard OIDC scopes the
          // MCP 401 challenge tells clients to request. Deriving these from the OPTIONAL
          // `scope` field of the registration request used to leave a client that omitted it
          // unable to authorize at all — see assignStandardOidcScopes.
          await assignStandardOidcScopes(admin, createdClient.id, clientId, allClientScopes)

          // RFC 8707: attach the resource-indicators default scope so this
          // dynamically-registered client's access-token aud binds to the
          // FHIR/MCP resource server (otherwise token exchange with a resource
          // param → invalid_target). Applies to every DCR client automatically.
          await assignResourceIndicatorsScope(admin, createdClient.id, clientId, allClientScopes)

          // Anything the client additionally asked for. SMART/FHIR scopes go to OPTIONAL so the
          // user has to request them explicitly; the standard OIDC ones are already attached
          // above, so they are skipped here rather than assigned twice.
          if (grantedScope) {
            logger.admin.debug('Configuring requested client scopes', { clientId, scope: grantedScope })
            const baseline = new Set<string>([
              ...KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
              ...STANDARD_OIDC_DEFAULT_SCOPES,
              ...STANDARD_OIDC_OPTIONAL_SCOPES,
            ])

            for (const scopeName of grantedScope.split(' ')) {
              if (!scopeName || baseline.has(scopeName)) continue
              const matchingScope = allClientScopes.find(s => s.name === scopeName)
              if (!matchingScope?.id) {
                // Scope doesn't exist in Keycloak - log but continue
                // SMART FHIR scopes like patient/*.read may need custom scope creation
                logger.admin.debug('Scope not found in Keycloak, skipping', { clientId, scopeName })
                continue
              }
              try {
                await admin.clients.addOptionalClientScope({
                  id: createdClient.id,
                  clientScopeId: matchingScope.id,
                })
                // Auto-provision SMART protocol mappers if needed
                if (SMART_SCOPE_MAPPERS[scopeName]) {
                  await ensureScopeMappers(admin, matchingScope.id, scopeName)
                }
                logger.admin.debug('Assigned requested scope to client', { clientId, scopeName })
              } catch (scopeError) {
                logger.admin.warn('Failed to assign scope to client', { clientId, scopeName, error: scopeError })
              }
            }
          }
        } catch (scopeError) {
          logger.admin.warn('Failed to configure client scopes', { clientId, error: scopeError })
        }
      }

      // Send notification if configured
      if (settings.notificationEmail) {
        logger.admin.info('New client registration requires notification', {
          clientId,
          clientName: body.client_name,
          notificationEmail: settings.notificationEmail,
          requiresApproval: settings.adminApprovalRequired
        })
        // TODO: Implement email notification
      }

      const response: ClientRegistrationResponse = {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        // RFC 7592. Returned exactly once; only its hash is stored.
        registration_access_token: registrationAccessToken,
        registration_client_uri: `${config.baseUrl.replace(/\/+$/, '')}/auth/register/${clientId}`,
        redirect_uris: body.redirect_uris,
        grant_types: registeredGrantTypes(kind, authorizationCode),
        response_types: authorizationCode ? ['code'] : [],
        client_name: body.client_name,
        client_uri: body.client_uri,
        logo_uri: body.logo_uri,
        scope: grantedScope || settings.allowedScopes.filter(scope =>
          ['openid', 'profile', 'fhirUser', 'launch', 'patient/*.read', 'user/*.read'].includes(scope)
        ).join(' '),
        contacts: body.contacts,
        tos_uri: body.tos_uri,
        policy_uri: body.policy_uri,
        jwks_uri: body.jwks_uri,
        jwks: body.jwks,
        token_endpoint_auth_method: isConfidential ? 'private_key_jwt' : 'none',
        fhir_versions: body.fhir_versions,
        launch_uris: body.launch_uris
      }

      const logMessage = settings.adminApprovalRequired 
        ? 'Client registered but requires admin approval' 
        : 'Client registered and activated'
        
      logger.admin.info(logMessage, { 
        clientId, 
        isConfidential: isConfidential,
        isBackendService,
        requiresApproval: settings.adminApprovalRequired 
      })

      // Refresh CORS origins cache (new client has webOrigins)
      refreshCorsOrigins().catch(() => {})

      // RFC 7591 3.2.1: a successful registration is 201, not 200. Strict clients check it —
      // oauth4webapi rejects 200 outright, so AIHR could never finish a connector sign-in even
      // though the client had already been created here, and re-registered on every attempt.
      set.status = 201
      return response

    } catch (error) {
      logger.admin.error('Client registration failed', { error })
      set.status = 500
      return {
        error: 'server_error',
        error_description: 'Failed to register client'
      }
    }
  }, {
    transform: authEndpointRateLimit(),
    body: ClientRegistrationRequest,
    response: {
      200: ClientRegistrationResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Dynamic Client Registration',
      description: 'Register a new OAuth2 client dynamically according to RFC 7591. This is a public endpoint that does not require authentication.',
      tags: ['authentication']
    }
  })

  /**
   * RFC 7592 client configuration endpoint — read your own registration.
   *
   * Authenticated by the `registration_access_token` handed out at registration, NOT by an
   * end-user token: this is the client managing itself, and there may be no user involved at
   * all. The token is scoped to exactly one client, so possession of it plus a matching
   * `clientId` in the path is the whole authorisation check.
   */
  .get('/register/:clientId', async ({ params, headers, set }) => {
    const outcome = await authenticateRegistration(params.clientId, headers)
    if ('error' in outcome) {
      set.status = outcome.status
      set.headers['WWW-Authenticate'] = 'Bearer error="invalid_token"'
      return outcome.error
    }
    const { client } = outcome
    return {
      client_id: params.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris ?? [],
      grant_types: client.attributes?.['oauth2.device.authorization.grant.enabled'] === 'true'
        ? ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']
        : ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: toTokenEndpointAuthMethod(client),
      registration_client_uri: `${config.baseUrl.replace(/\/+$/, '')}/auth/register/${client.clientId}`,
    }
  }, {
    transform: authEndpointRateLimit(),
    detail: {
      summary: 'Read a dynamic client registration (RFC 7592)',
      description:
        'Returns the current registration for a dynamically-registered client. Authenticate with the registration_access_token issued at registration, as an OAuth 2.0 Bearer token.',
      tags: ['authentication'],
    },
  })

  /**
   * RFC 7592 client configuration endpoint — deprovision yourself.
   *
   * The reason this exists: without it a dynamically-registered client has NO standard way to
   * clean up after itself, so every short-lived client an MCP host or a test run creates stays
   * forever. `lib/dcr-client-reaper.ts` sweeps up the ones that never call this, but a client
   * that knows it is finished should say so rather than wait a year to be retired.
   *
   * 204 on success, per RFC 7592 §2.3.
   */
  .delete('/register/:clientId', async ({ params, headers, set }) => {
    const outcome = await authenticateRegistration(params.clientId, headers)
    if ('error' in outcome) {
      set.status = outcome.status
      set.headers['WWW-Authenticate'] = 'Bearer error="invalid_token"'
      return outcome.error
    }
    try {
      const admin = await getServiceAccountAdmin()
      await admin.clients.del({ id: outcome.id })
      logger.admin.info('Client deprovisioned itself (RFC 7592)', { clientId: params.clientId })
      set.status = 204
      return
    } catch (error) {
      logger.admin.error('RFC 7592 deregistration failed', { clientId: params.clientId, error })
      set.status = 500
      return { error: 'server_error', error_description: 'Failed to delete client' }
    }
  }, {
    transform: authEndpointRateLimit(),
    detail: {
      summary: 'Deregister a dynamic client (RFC 7592)',
      description:
        'Deletes a dynamically-registered client. Authenticate with the registration_access_token issued at registration. Responds 204 No Content on success.',
      tags: ['authentication'],
    },
  })

  /**
   * RFC 7592 §2 requires an unsupported method on this endpoint to be refused explicitly rather
   * than fall through to a 404, which a client cannot distinguish from a wrong client_id.
   *
   * PUT is not supported on purpose: updating a registration means re-running the redirect-URI,
   * scope and client-type validation that registration does, and a second, subtly different
   * copy of those rules is how the two drift. Re-register, or use the admin API.
   */
  .put('/register/:clientId', ({ set }) => {
    set.status = 405
    set.headers['Allow'] = 'GET, DELETE'
    return {
      error: 'invalid_request',
      error_description: 'Updating a registration is not supported. Register again, or use the admin API.',
    }
  }, {
    detail: {
      summary: 'Update a dynamic client registration (unsupported)',
      description: 'Always responds 405. RFC 7592 requires an explicit refusal for unsupported methods.',
      tags: ['authentication'],
    },
  })
