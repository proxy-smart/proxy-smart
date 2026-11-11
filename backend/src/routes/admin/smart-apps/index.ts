// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** SMART app clients, managed with the caller's own token; representations in ./create- and ./update-representation, follow-up steps in ./provisioning and ./key-material. */

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
import { requireAdminClient } from '@/lib/admin-utils'
import { refreshCorsOrigins } from '@/lib/cors-origins'
import { enrichClient } from '@/lib/smart-client-enrichment'
import { maskClientSecret } from '@/lib/secret-mask'
import { BACKEND_SERVICE_DEFAULT_SCOPES, STANDARD_OIDC_DEFAULT_SCOPES } from '@/lib/oauth-scopes'
import { invalidateClientConfig } from '@/lib/smart-client-config-cache'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { buildCreatePlan, validateCreateRequest } from './create-representation'
import { preferredIdentityProviderRejection } from './preferred-identity-provider'
import { buildUpdateRepresentation } from './update-representation'
import { ensureResourceIndicatorsScope, removeResourceAudience } from '@/lib/kc-system-provisioning'
import { resourceServerRejection } from '@/lib/resource-server-exchange'
import { findRealmAppClient, isRealmAppClient } from '@/lib/realm-clients'
import {
  addAudienceMappers,
  assignScopesToNewClient,
  createClientRoles,
  enableOfflineAccess,
  replaceAudienceMappers,
  replaceScopesForClient,
  syncClientRoles,
} from './provisioning'
import { KeyMaterialError, registerJwksForClient } from './key-material'

/** `systemScopes` is the backend-service spelling of optional scopes; merged and de-duplicated, as Keycloak rejects a scope assigned twice. */
function withSystemScopes(optionalScopes?: string[], systemScopes?: string[]): string[] | undefined {
  if (!optionalScopes && !systemScopes) return undefined
  return [...new Set([...(optionalScopes ?? []), ...(systemScopes ?? [])])]
}

export const smartAppsRoutes = new Elysia({ prefix: '/smart-apps', tags: ['smart-apps'] })
  .use(keycloakPlugin)

  .get('/', async ({ getAdmin, headers, set }): Promise<SmartAppType[] | ErrorResponseType> => {
    try {
      const admin = await requireAdminClient({ getAdmin, headers })
      const clients = await admin.clients.find()

      const smartApps = clients.filter(isRealmAppClient)

      return await Promise.all(
        smartApps.map(async (client) => {
          try {
            return await enrichClient(admin, client)
          } catch (error) {
            logger.admin.warn('Failed to enrich client with scope details', { clientId: client.clientId, error })
            return maskClientSecret(client)
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
      const rejection = validateCreateRequest(body)
      if (rejection) {
        set.status = 400
        return { error: rejection }
      }

      const admin = await requireAdminClient({ getAdmin, headers })
      const providerRejection = await preferredIdentityProviderRejection((alias) => admin.identityProviders.findOne({ alias }), body.preferredIdentityProvider)
      if (providerRejection) {
        set.status = 400
        return { error: providerRejection }
      }
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

      await assignScopesToNewClient(admin, client, {
        defaultScopes: body.defaultClientScopes
          ?? [...(isBackendService ? BACKEND_SERVICE_DEFAULT_SCOPES : STANDARD_OIDC_DEFAULT_SCOPES)],
        optionalScopes: withSystemScopes(body.optionalClientScopes, body.systemScopes) ?? [],
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
          // A jwksUri is never fetched, so its signing alg is stated; the authenticator stays the one asked for.
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

          return maskClientSecret(updatedClient || finalClientForResponse)
        } catch (keyError) {
          // Clean up created client if key registration fails
          await admin.clients.del({ id: client.id })
          return handleAdminError(keyError, set)
        }
      }

      // Refresh CORS origins cache (new app may have webOrigins)
      refreshCorsOrigins().catch(() => {})

      return maskClientSecret(finalClientForResponse)
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
      const admin = await requireAdminClient({ getAdmin, headers })
      const client = await findRealmAppClient(admin, params.clientId)
      if (!client) {
        set.status = 404
        return { error: 'SMART application not found' }
      }

      let enrichedClient: SmartAppType | ClientRepresentation = maskClientSecret(client)
      try {
        enrichedClient = await enrichClient(admin, client)
      } catch (error) {
        logger.admin.warn('Failed to enrich individual client with scope details', { clientId: client.clientId, error })
      }

      const serviceAccountUserId = client.serviceAccountsEnabled && client.id
        ? (await admin.clients.getServiceAccountUser({ id: client.id }).catch(() => undefined))?.id
        : undefined
      return serviceAccountUserId ? { ...enrichedClient, serviceAccountUserId } : enrichedClient
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
      const admin = await requireAdminClient({ getAdmin, headers })
      const existing = await findRealmAppClient(admin, params.clientId)
      if (!existing?.id || !existing.clientId) {
        set.status = 404
        return { error: 'SMART application not found' }
      }
      const client = { id: existing.id, clientId: existing.clientId }

      const rejection = (body.resourceServer ? resourceServerRejection(client.clientId) : null)
        ?? await preferredIdentityProviderRejection((alias) => admin.identityProviders.findOne({ alias }), body.preferredIdentityProvider)
      if (rejection) {
        set.status = 400
        return { error: rejection }
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

      const optionalScopes = withSystemScopes(body.optionalClientScopes, body.systemScopes)
      if (body.defaultClientScopes || optionalScopes) {
        await replaceScopesForClient(admin, client, {
          defaultScopes: body.defaultClientScopes,
          optionalScopes,
        })
      }

      refreshCorsOrigins().catch(() => {})
      invalidateClientConfig(params.clientId)

      return { success: true, message: 'SMART application updated successfully' }
    } catch (error) {
      if (error instanceof KeyMaterialError) {
        set.status = 400
        return { error: error.message }
      }
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
      const admin = await requireAdminClient({ getAdmin, headers })
      const clientUuid = (await findRealmAppClient(admin, params.clientId))?.id
      if (!clientUuid) {
        set.status = 404
        return { error: 'SMART application not found' }
      }
      await admin.clients.del({ id: clientUuid })

      // Refresh CORS origins cache (removed app's webOrigins should be cleared)
      refreshCorsOrigins().catch(() => {})
      invalidateClientConfig(params.clientId)

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
