// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { logger } from '@/lib/logger'
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
import { toTokenEndpointAuthMethod } from '@/lib/auth-method-mapping'
import { buildDcrClient, registeredGrantTypes } from './dcr-client'
import { configureClientScopes, vetRegistration } from './client-provisioning'
import { trimTrailingSlashes } from '@proxy-smart/guards'
import { DYNAMIC_REGISTRATION_ATTRIBUTE } from '@/lib/realm-clients'

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
  fhir_versions?: string[]
  launch_uris?: string[]
}

/** An authenticated RFC 7592 request, or the error to return for it. */
type RegistrationAuth =
  | { client: ClientRepresentation; id: string }
  | { error: { error: string; error_description: string }; status: number }

// Every failure is the same 401 so this endpoint cannot be used to enumerate client ids.
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
  // First-party clients from realm-export must never be deletable through this path.
  if (client.attributes?.[DYNAMIC_REGISTRATION_ATTRIBUTE] !== 'true') return unauthorized
  if (!registrationTokenMatches(presented, client.attributes?.[REGISTRATION_TOKEN_ATTRIBUTE])) {
    return unauthorized
  }
  return { client, id: client.id }
}

export const clientRegistrationRoutes = new Elysia({ tags: ['authentication'] })

  .post('/register', async ({ body, set }) => {
    try {
      const admin = await getServiceAccountAdmin()

      const settings = await getClientRegistrationSettings(admin)

      if (!settings.enabled) {
        set.status = 403
        return {
          error: 'access_denied',
          error_description: 'Dynamic client registration is currently disabled'
        }
      }
      
      const vetting = await vetRegistration(body, settings)
      if (!vetting.ok) {
        set.status = 400
        return { error: vetting.error, error_description: vetting.error_description }
      }
      const { kind, authorizationCode, grantedScope } = vetting
      const isConfidential = kind !== 'public'
      const isBackendService = kind === 'backend-service'

      const clientId = `smart_app_${crypto.randomUUID()}`
      // RFC 7592 token, generated first so its hash goes in with the initial attributes.
      const registrationAccessToken = generateRegistrationAccessToken()

      const now = Date.now()
      const { representation } = buildDcrClient({
        clientId,
        body,
        settings,
        registration: { via: 'dynamic-registration', tokenHash: hashRegistrationAccessToken(registrationAccessToken) },
        now,
      })
      const createdClient = await admin.clients.create(representation)
      if (createdClient.id) await configureClientScopes(admin, createdClient.id, clientId, grantedScope)

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
        // Returned exactly once; only its hash is stored.
        registration_access_token: registrationAccessToken,
        registration_client_uri: `${trimTrailingSlashes(config.baseUrl)}/auth/register/${clientId}`,
        redirect_uris: body.redirect_uris,
        grant_types: registeredGrantTypes(kind, authorizationCode),
        response_types: authorizationCode ? ['code'] : [],
        client_name: body.client_name,
        client_uri: body.client_uri,
        logo_uri: body.logo_uri,
        scope: grantedScope,
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

      refreshCorsOrigins().catch(() => {})

      // RFC 7591 3.2.1: strict clients such as oauth4webapi reject a 200.
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

  // RFC 7592: the registration_access_token alone authorises; no end user is involved.
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
      registration_client_uri: `${trimTrailingSlashes(config.baseUrl)}/auth/register/${client.clientId}`,
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

  // Clients that never call this are swept up by lib/dcr-client-reaper.ts.
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

  // Unsupported on purpose, so registration validation has one copy; RFC 7592 §2 wants an explicit refusal.
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
