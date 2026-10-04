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
import { validateExternalUrl } from '@/lib/url-validation'
import { resolveClientHomeUrl } from '@proxy-smart/auth'
import { withProxyCallback } from '../admin/smart-apps/client-config'

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
  | { client: ClientRepresentation }
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
  return { client }
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
      
      // Validate redirect URIs
      if (!body.redirect_uris || body.redirect_uris.length === 0) {
        set.status = 400
        return {
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required'
        }
      }

      // Check redirect URI limit
      if (body.redirect_uris.length > settings.maxRedirectUris) {
        set.status = 400
        return {
          error: 'invalid_redirect_uri',
          error_description: `Maximum ${settings.maxRedirectUris} redirect URIs allowed`
        }
      }

      // Validate HTTPS requirement
      if (settings.requireHttps) {
        const invalidUris = body.redirect_uris.filter(uri => 
          !uri.startsWith('https://') && 
          !uri.startsWith('http://localhost') && 
          !uri.startsWith('http://127.0.0.1')
        )
        if (invalidUris.length > 0) {
          set.status = 400
          return {
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uris must use HTTPS (localhost exempted for development)'
          }
        }
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

      // VULN 2 (HIGH) — registration-layer SSRF guard (fail-closed).
      // A client-supplied jwks_uri is fetched server-side during private_key_jwt
      // assertion validation (backend-services.ts → fetchJwksUrl). Reject any
      // jwks_uri that targets an internal/metadata/RFC1918/link-local host (or a
      // non-http(s) scheme) at write time, so the malicious URL is never stored.
      // The fetch layer re-validates (defense in depth); this layer fails closed.
      // Reuses the shared validateExternalUrl helper (DRY). The dev/docker
      // carve-out mirrors fhir-servers.ts so internal federation still works
      // locally; the guard is fully active in test and production.
      if (body.jwks_uri) {
        const allowInternal = process.env.NODE_ENV === 'development'
        const jwksUriCheck = validateExternalUrl(body.jwks_uri, allowInternal)
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

      // Determine client type based on authentication method
      const isConfidential = !!(body.jwks_uri || body.jwks)
      const isBackendService = isConfidential && !body.redirect_uris.some(uri => 
        uri.includes('localhost') || uri.includes('127.0.0.1')
      )
      
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

      // Filter requested scopes to only those allowed by server policy.
      // Per RFC 7591 §2, the server MAY grant fewer scopes than requested —
      // rejecting the entire registration for unsupported scopes breaks
      // clients like VS Code that pass their resource metadata scopes verbatim.
      if (body.scope) {
        const requestedScopes = body.scope.split(' ')
        const allowedRequestedScopes = requestedScopes.filter(scope =>
          settings.allowedScopes.includes(scope)
        )
        // Replace with filtered scope string (may be empty → server defaults apply)
        body.scope = allowedRequestedScopes.join(' ') || undefined as unknown as string
      }

      const clientId = `smart_app_${crypto.randomUUID()}`
      // RFC 7592: the credential the client will use to read or delete its own registration.
      // Generated before the client so its hash can go in with the initial attributes.
      const registrationAccessToken = generateRegistrationAccessToken()

      // Build Keycloak client configuration (reusing logic from smart-apps.ts)
      // The proxy intercepts SMART flows by rewriting redirect_uri to its own
      // callback (/auth/smart-callback). Keycloak validates redirect_uris per-client,
      // so we must include the proxy callback alongside the app's own URIs.
      const allRedirectUris = withProxyCallback(body.redirect_uris, false)

      // Keycloak's error page offers this as "Back to application". Unset, it fell back to the
      // proxy's own origin, so a broker failure sent every app's user to Proxy Smart.
      const homeUrl = resolveClientHomeUrl({
        clientUri: body.client_uri,
        redirectUris: body.redirect_uris,
        proxyBaseUrl: config.baseUrl,
      })

      const keycloakClient = {
        clientId,
        name: body.client_name || clientId,
        ...(homeUrl && { baseUrl: homeUrl }),
        description: `SMART App: ${body.client_name || 'Dynamic Client'}`,
        enabled: !settings.adminApprovalRequired, // Disable if approval required
        protocol: 'openid-connect',
        publicClient: !isConfidential,
        fullScopeAllowed: true, // Include all user roles in the token (realm_access.roles)
        standardFlowEnabled: true, // Authorization code flow
        serviceAccountsEnabled: isBackendService, // Backend services
        // Ask the user before an unknown third party gets access. Two reasons this is not
        // optional-feeling: (1) a DCR client registered ITSELF, so nobody has vetted it, and
        // (2) Keycloak IGNORES a client's own `prompt=consent` unless the client is flagged this
        // way — claude.ai sends exactly that and was being silently overridden, so the user was
        // never shown the choice the client asked to present. Backend services are exempt: there
        // is no user in a client_credentials flow to consent, and flagging them would break it.
        consentRequired: settings.requireConsent && !isBackendService,
        redirectUris: allRedirectUris,
        webOrigins: body.redirect_uris.map(uri => {
          try {
            return new URL(uri).origin
          } catch {
            return uri // fallback for invalid URIs
          }
        }),
        // Client authentication type:
        // - Backend services: proxy validates JWT, authenticates to KC with client-secret
        // - Confidential with JWKS: proxy re-signs assertions → KC verifies via federated-jwt
        // - Public: no authentication
        clientAuthenticatorType: isBackendService
          ? 'client-secret'
          : isConfidential
            ? 'federated-jwt'
            : 'none',
        attributes: {
          'pkce.code.challenge.method': 'S256',
          'client.secret.creation.time': Date.now().toString(),
          'smart_app': 'true', // Mark as SMART app to work with existing filtering
          'smart.fhir_versions': body.fhir_versions?.join(',') || 'R4',
          'smart.launch_uris': body.launch_uris?.join(',') || '',
          'smart.client_uri': body.client_uri || '',
          'smart.logo_uri': body.logo_uri || '',
          // Keycloak 25+ requires explicit post-logout redirect URI config
          'post.logout.redirect.uris': '+',
          // Dynamic registration metadata
          'dynamic_registration': 'true',
          'registration_date': Date.now().toString(),
          // RFC 7592: only the hash is kept. The plaintext goes back in the registration
          // response once and is not recoverable afterwards.
          [REGISTRATION_TOKEN_ATTRIBUTE]: hashRegistrationAccessToken(registrationAccessToken),
          'approval_required': settings.adminApprovalRequired.toString(),
          'approved': (!settings.adminApprovalRequired).toString(),
          // Client lifetime
          ...(settings.maxClientLifetime > 0 && {
            'expires_at': (Date.now() + (settings.maxClientLifetime * 24 * 60 * 60 * 1000)).toString()
          }),
          // Federated-jwt: KC verifies proxy-signed assertions via the IdP
          ...(isConfidential && !isBackendService && {
            'jwt.credential.issuer': 'proxy-smart-signing',
            'jwt.credential.sub': clientId,
          }),
          ...(body.jwks_uri && {
            'use.jwks.url': 'true',
            'jwks.url': body.jwks_uri
          }),
          ...(body.jwks && {
            'use.jwks.string': 'true',
            'jwks.string': JSON.stringify(body.jwks)
          })
        }
      }

      // Create the client
      const createdClient = await admin.clients.create(keycloakClient)

      // Get client secret for confidential clients that use client-secret auth
      let clientSecret: string | undefined
      if (isConfidential && !body.jwks_uri && !body.jwks && createdClient.id) {
        try {
          const secret = await admin.clients.getClientSecret({ id: createdClient.id })
          clientSecret = secret.value
        } catch (error) {
          logger.admin.warn('Could not retrieve client secret', { error })
        }
      }

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
          if (body.scope) {
            logger.admin.debug('Configuring requested client scopes', { clientId, scope: body.scope })
            const baseline = new Set<string>([
              ...KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
              ...STANDARD_OIDC_DEFAULT_SCOPES,
              ...STANDARD_OIDC_OPTIONAL_SCOPES,
            ])

            for (const scopeName of body.scope.split(' ')) {
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

      // Build RFC 7591 compliant response
      const response: ClientRegistrationResponse = {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: clientSecret ? 0 : undefined, // 0 means never expires
        // RFC 7592. Returned exactly once — only its hash is stored, so a client that loses
        // this can no longer manage its own registration.
        registration_access_token: registrationAccessToken,
        registration_client_uri: `${config.baseUrl.replace(/\/+$/, '')}/auth/register/${clientId}`,
        redirect_uris: body.redirect_uris,
        grant_types: isBackendService 
          ? ['authorization_code', 'client_credentials', 'refresh_token']
          : ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: body.client_name,
        client_uri: body.client_uri,
        logo_uri: body.logo_uri,
        scope: body.scope || settings.allowedScopes.filter(scope => 
          ['openid', 'profile', 'fhirUser', 'launch', 'patient/*.read', 'user/*.read'].includes(scope)
        ).join(' '), // Default to safe scopes
        contacts: body.contacts,
        tos_uri: body.tos_uri,
        policy_uri: body.policy_uri,
        jwks_uri: body.jwks_uri,
        jwks: body.jwks,
        token_endpoint_auth_method: isConfidential
          ? (body.jwks_uri || body.jwks ? 'private_key_jwt' : 'client_secret_basic')
          : 'none',
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
      client_id: client.clientId!,
      client_name: client.name,
      redirect_uris: client.redirectUris ?? [],
      grant_types: client.attributes?.['oauth2.device.authorization.grant.enabled'] === 'true'
        ? ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']
        : ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: client.publicClient ? 'none' : 'client_secret_basic',
      registration_client_uri: `${config.baseUrl.replace(/\/+$/, '')}/auth/register/${client.clientId}`,
    }
  }, {
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
      await admin.clients.del({ id: outcome.client.id! })
      logger.admin.info('Client deprovisioned itself (RFC 7592)', { clientId: params.clientId })
      set.status = 204
      return
    } catch (error) {
      logger.admin.error('RFC 7592 deregistration failed', { clientId: params.clientId, error })
      set.status = 500
      return { error: 'server_error', error_description: 'Failed to delete client' }
    }
  }, {
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
