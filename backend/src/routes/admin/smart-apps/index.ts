// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART App (Client) Management - specialized for healthcare applications
 *
 * All routes use the caller's access token to perform operations, acting as a
 * secure proxy for Keycloak admin operations. The Keycloak representations live
 * in ./create-representation and ./update-representation; everything that
 * happens to a client after it is written lives in ./provisioning.
 */

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  SuccessResponse,
  CommonErrorResponses,
  SmartApp,
  CreateSmartAppRequest,
  UpdateSmartAppRequest,
  ClientIdParam,
  type SmartAppType,
  type SuccessResponseType,
  type ErrorResponseType
} from '@/schemas'
import { logger } from '@/lib/logger'
import { handleAdminError } from '@/lib/admin-error-handler'
import { extractBearerToken } from '@/lib/admin-utils'
import { refreshCorsOrigins } from '@/lib/cors-origins'
import { enrichClient } from '@/lib/smart-client-enrichment'
import { BACKEND_SERVICE_DEFAULT_SCOPES, STANDARD_OIDC_DEFAULT_SCOPES } from '@/lib/oauth-scopes'
import { invalidateClientConfig } from '@/lib/smart-client-config-cache'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { buildCreatePlan, validateCreateRequest } from './create-representation'
import { buildUpdateRepresentation } from './update-representation'
import { ensureResourceIndicatorsScope, removeResourceAudience } from '@/lib/kc-system-provisioning'
import { resourceServerRejection } from '@/lib/resource-server-exchange'
import {
  addAudienceMappers,
  assignScopesToNewClient,
  createClientRoles,
  enableOfflineAccess,
  registerJwksForClient,
  replaceAudienceMappers,
  replaceScopesForClient,
  syncClientRoles,
} from './provisioning'

/** Keycloak built-in / internal clients that should never appear in the SMART app list */
const INTERNAL_CLIENTS = new Set([
  'account',
  'account-console',
  'admin-cli',
  'broker',
  'realm-management',
  'security-admin-console',
  'admin-ui',
])

export const smartAppsRoutes = new Elysia({ prefix: '/smart-apps', tags: ['smart-apps'] })
  .use(keycloakPlugin)

  .get('/', async ({ getAdmin, headers, set }): Promise<SmartAppType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const clients = await admin.clients.find()

      // Any openid-connect client that isn't a Keycloak internal client and
      // isn't bearer-only (those are service-level tokens, not SMART apps)
      const smartApps = clients.filter(client =>
        client.protocol === 'openid-connect' &&
        !client.bearerOnly &&
        !INTERNAL_CLIENTS.has(client.clientId ?? '')
      )

      return await Promise.all(
        smartApps.map(async (client) => {
          try {
            return await enrichClient(admin, client)
          } catch (error) {
            logger.admin.warn('Failed to enrich client with scope details', { clientId: client.clientId, error })
            return client
          }
        })
      )
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: t.Array(SmartApp),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List SMART on FHIR Applications',
      description: 'Get all registered SMART on FHIR applications',
      tags: ['smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .post('/', async ({ getAdmin, body, headers, set }): Promise<SmartAppType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const rejection = validateCreateRequest(body)
      if (rejection) {
        set.status = 400
        return { error: rejection }
      }

      const admin = await getAdmin(token)
      const { representation, isBackendService, signingAlg } = buildCreatePlan(body)

      logger.admin.debug('Creating client with config', { clientId: body.clientId })
      const createdClient = await admin.clients.create(representation)

      // Keycloak returns just the ID, so fetch the full client details
      const fullClient = await admin.clients.findOne({ id: createdClient.id })
      if (!fullClient?.id || !fullClient.clientId) {
        throw new Error('Client created but could not retrieve details')
      }
      const client = { id: fullClient.id, clientId: fullClient.clientId }

      logger.admin.debug('Client created, details:', {
        clientId: fullClient.clientId,
        clientAuthenticatorType: fullClient.clientAuthenticatorType,
        serviceAccountsEnabled: fullClient.serviceAccountsEnabled,
        standardFlowEnabled: fullClient.standardFlowEnabled
      })

      /*
       * `systemScopes` is the backend-service spelling of optional scopes, and was accepted by the
       * schema while being read nowhere — a client registered with system/Patient.c came back with
       * no scope attached and no error. Merged rather than replacing, so a caller may pass both,
       * and de-duplicated because assigning the same scope twice is a Keycloak error.
       */
      await assignScopesToNewClient(admin, client, {
        defaultScopes: body.defaultClientScopes
          ?? [...(isBackendService ? BACKEND_SERVICE_DEFAULT_SCOPES : STANDARD_OIDC_DEFAULT_SCOPES)],
        optionalScopes: [...new Set([...(body.optionalClientScopes || []), ...(body.systemScopes || [])])],
      })

      if (body.allowOfflineAccess) {
        await enableOfflineAccess(admin, client)
      }

      if (body.audienceClients && body.audienceClients.length > 0) {
        await addAudienceMappers(admin, client, body.audienceClients)
      }

      if (body.resourceServer) {
        await ensureResourceIndicatorsScope(admin)
      }

      // Re-fetch to pick up the scope assignments
      const clientAfterScopeAssignment = await admin.clients.findOne({ id: createdClient.id })
      const finalClientForResponse = clientAfterScopeAssignment || fullClient

      if (body.requiredRoles && body.requiredRoles.length > 0) {
        await createClientRoles(admin, client, body.requiredRoles)
      }

      // Register JWKS for Backend Services clients (proxy validates the JWT
      // externally, authenticates to Keycloak with the registered key material)
      if (isBackendService && (body.publicKey || body.jwksString || body.jwksUri)) {
        try {
          if (body.publicKey || body.jwksString) {
            await registerJwksForClient(admin, client.id, {
              publicKeyPem: body.publicKey,
              jwksString: body.jwksString,
              signingAlg: body.tokenEndpointAuthSigningAlg,
            })
          }
          /*
           * jwksUri is already stored during creation; only the signing alg needs stating, because
           * nothing fetches the URI to discover it.
           *
           * This used to also force `clientAuthenticatorType: 'client-secret'`, which made
           * private_key_jwt unusable with a jwksUri: the authenticator computed from
           * tokenEndpointAuthMethod (federated-jwt) was overwritten immediately after being set, so
           * a client registered for assertion auth came back expecting a shared secret. The
           * jwksString path never did this, and the federated-jwt clients in production prove it is
           * not required. The authenticator is left as the caller asked for.
           */
          if (body.jwksUri && !body.publicKey && !body.jwksString) {
            await admin.clients.update({ id: client.id }, {
              attributes: {
                ...fullClient.attributes,
                'token.endpoint.auth.signing.alg': signingAlg,
              }
            })
          }

          const updatedClient = await admin.clients.findOne({ id: client.id })

          // Refresh CORS origins cache (new app may have webOrigins)
          refreshCorsOrigins().catch(() => {})

          return updatedClient || finalClientForResponse
        } catch (keyError) {
          // Clean up created client if key registration fails
          await admin.clients.del({ id: client.id })
          return handleAdminError(keyError, set)
        }
      }

      // Refresh CORS origins cache (new app may have webOrigins)
      refreshCorsOrigins().catch(() => {})

      return finalClientForResponse
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateSmartAppRequest,
    response: {
      200: SmartApp,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create SMART on FHIR Application',
      description: 'Create a new SMART on FHIR application',
      tags: ['smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .get('/:clientId', async ({ getAdmin, params, headers, set }): Promise<SmartAppType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const clients = await admin.clients.find({ clientId: params.clientId })
      if (!clients[0]) {
        set.status = 404
        return { error: 'SMART application not found' }
      }

      let enrichedClient: SmartAppType | ClientRepresentation = clients[0]
      try {
        enrichedClient = await enrichClient(admin, clients[0])
      } catch (error) {
        logger.admin.warn('Failed to enrich individual client with scope details', { clientId: clients[0].clientId, error })
      }

      return enrichedClient
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientIdParam,
    response: {
      200: SmartApp,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get SMART on FHIR Application',
      description: 'Get a single SMART on FHIR application by clientId',
      tags: ['smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .put('/:clientId', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const clients = await admin.clients.find({ clientId: params.clientId })
      const existing = clients[0]
      if (!existing?.id || !existing.clientId) {
        set.status = 404
        return { error: 'SMART application not found' }
      }
      const client = { id: existing.id, clientId: existing.clientId }

      const resourceRejection = body.resourceServer ? resourceServerRejection(client.clientId) : null
      if (resourceRejection) {
        set.status = 400
        return { error: resourceRejection }
      }

      await admin.clients.update({ id: client.id }, buildUpdateRepresentation(body, existing))

      if (body.resourceServer === true) await ensureResourceIndicatorsScope(admin)
      if (body.resourceServer === false) await removeResourceAudience(admin, client.clientId)

      if (body.requiredRoles !== undefined) {
        await syncClientRoles(admin, client, body.requiredRoles)
      }

      if (body.audienceClients !== undefined) {
        await replaceAudienceMappers(admin, client, body.audienceClients)
      }

      if (body.defaultClientScopes || body.optionalClientScopes) {
        await replaceScopesForClient(admin, client, {
          defaultScopes: body.defaultClientScopes,
          optionalScopes: body.optionalClientScopes,
        })
      }

      // Stores JWKS for proxy-side JWT validation
      if (body.jwksString || body.publicKey || body.jwksUri) {
        try {
          await registerJwksForClient(admin, client.id, {
            jwksString: body.jwksString,
            publicKeyPem: body.publicKey,
          })
          logger.admin.debug('JWKS updated for client', { clientId: params.clientId })
        } catch (error) {
          logger.admin.warn('Failed to update JWKS for client', { clientId: params.clientId, error })
        }
      }

      // Refresh CORS origins cache (webOrigins may have changed)
      refreshCorsOrigins().catch(() => {})

      // Invalidate client config cache (patientFacing etc. may have changed)
      invalidateClientConfig(params.clientId)

      return { success: true, message: 'SMART application updated successfully' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientIdParam,
    body: UpdateSmartAppRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update SMART on FHIR Application',
      description: 'Update an existing SMART on FHIR application',
      tags: ['smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })

  .delete('/:clientId', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const clients = await admin.clients.find({ clientId: params.clientId })
      if (!clients[0]) {
        set.status = 404
        return { error: 'SMART application not found' }
      }
      await admin.clients.del({ id: clients[0].id! })

      // Refresh CORS origins cache (removed app's webOrigins should be cleared)
      refreshCorsOrigins().catch(() => {})

      return { success: true, message: 'SMART application deleted successfully' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: ClientIdParam,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete SMART on FHIR Application',
      description: 'Delete a SMART on FHIR application by clientId',
      tags: ['smart-apps'],
      security: [{ BearerAuth: [] }]
    }
  })
