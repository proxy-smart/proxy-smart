// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  CreateIdentityProviderRequest,
  UpdateIdentityProviderRequest,
  IdentityProviderResponse,
  CountResponse,
  SuccessResponse,
  type CountResponseType,
  type IdentityProviderResponseType,
  type SuccessResponseType,
  type ErrorResponseType,
  type IdentityProviderType,
  type CreateIdentityProviderRequestType,
  type UpdateIdentityProviderRequestType
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { extractBearerToken } from '@/lib/admin-utils'
import { ensureIdpAttributeMappers } from '@/lib/idp-mappers'
import { missingConfigKeys } from '@/lib/idp-required-config'
import { logger } from '@/lib/logger'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'

const normalizeProvider = (
  provider: IdentityProviderRepresentation | IdentityProviderType,
  userCount?: number
): IdentityProviderResponseType => ({
  alias: provider.alias,
  providerId: provider.providerId,
  displayName: provider.displayName,
  enabled: provider.enabled,
  config: provider.config ?? {},
  addReadTokenRoleOnCreate: provider.addReadTokenRoleOnCreate,
  firstBrokerLoginFlowAlias: provider.firstBrokerLoginFlowAlias,
  internalId: provider.internalId,
  linkOnly: provider.linkOnly,
  hideOnLogin: provider.hideOnLogin,
  postBrokerLoginFlowAlias: provider.postBrokerLoginFlowAlias,
  storeToken: provider.storeToken,
  trustEmail: provider.trustEmail,
  organizationId: provider.organizationId,
  userCount
})

/**
 * Identity Provider Management - handles external IdP integrations
 */
export const identityProvidersRoutes = new Elysia({ prefix: '/idps' })
  .use(keycloakPlugin)

  .get('/count', async ({ getAdmin, headers, set }): Promise<CountResponseType | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token, 'read')
      const providers = await admin.identityProviders.find()
      // Count only enabled providers
      const enabledCount = providers.filter(provider => provider.enabled !== false).length
      return { count: enabledCount, total: providers.length }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: CountResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Identity Providers Count',
      description: 'Get the count of enabled and total identity providers',
      tags: ['identity-providers']
    }
  })

  .get('/', async ({ getAdmin, headers, set }): Promise<IdentityProviderResponseType[] | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

  const admin = await getAdmin(token, 'read')
  const providers = await admin.identityProviders.find()

  // Fetch user counts per IdP in parallel
  const userCounts = await Promise.all(
    providers.map(async (provider) => {
      if (!provider.alias) return 0
      try {
        return await admin.users.count({ idpAlias: provider.alias } as Record<string, string>)
      } catch {
        return 0
      }
    })
  )

  return providers.map((provider, i) => normalizeProvider(provider, userCounts[i]))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: {
      200: t.Array(IdentityProviderResponse),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'List Identity Providers',
      description: 'Get all configured identity providers',
      tags: ['identity-providers']
    }
  })

  .post('/', async ({ getAdmin, body, headers, set }): Promise<IdentityProviderResponseType | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const payload = body as CreateIdentityProviderRequestType

      if (!payload.alias || !payload.providerId) {
        set.status = 400
        return { error: 'Alias and providerId are required' }
      }

      // Keycloak answers 500 `unknown_error` for an incomplete provider, naming nothing.
      // Refuse first, and say which keys are missing.
      const missing = missingConfigKeys(payload.providerId, payload.config as Record<string, unknown>)
      if (missing.length > 0) {
        set.status = 400
        return {
          error: `Missing required config for providerId "${payload.providerId}": ${missing.join(', ')}. ` +
            `Supply them under "config".`,
        }
      }

      await admin.identityProviders.create({
        ...payload,
        config: payload.config ?? {}
      } as IdentityProviderRepresentation)

      // Brokered users arrive with none of the SMART attributes unless an IdP
      // mapper imports them, so provision the expected imports up front.
      // Best-effort: a provider type without attribute mappers is still valid.
      try {
        const mapperResult = await ensureIdpAttributeMappers(admin, payload.alias)
        if (mapperResult.created.length > 0) {
          logger.admin.info('Provisioned SMART attribute mappers on new identity provider', {
            alias: payload.alias,
            created: mapperResult.created
          })
        }
      } catch (mapperError) {
        logger.admin.warn('Could not provision SMART attribute mappers on new identity provider', {
          alias: payload.alias,
          error: mapperError instanceof Error ? mapperError.message : mapperError
        })
      }

      const created = await admin.identityProviders.findOne({ alias: payload.alias })
      return normalizeProvider((created ?? payload) as IdentityProviderType)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateIdentityProviderRequest,
    response: {
      200: IdentityProviderResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Create Identity Provider',
      description: 'Create a new identity provider',
      tags: ['identity-providers']
    }
  })

  .get('/:alias', async ({ getAdmin, params, headers, set }): Promise<IdentityProviderResponseType | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token, 'read')
      const provider = await admin.identityProviders.findOne({ alias: params.alias })
      if (!provider) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }
      return normalizeProvider({ ...provider, alias: provider.alias ?? params.alias })
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      alias: t.String({ description: 'Identity provider alias' })
    }),
    response: {
      200: IdentityProviderResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get Identity Provider',
      description: 'Get an identity provider by alias',
      tags: ['identity-providers']
    }
  })

  .put('/:alias', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      const existing = await admin.identityProviders.findOne({ alias: params.alias })
      if (!existing) {
        set.status = 404
        return { error: 'Identity provider not found' }
      }

      const updatePayload = body as UpdateIdentityProviderRequestType

      await admin.identityProviders.update(
        { alias: params.alias },
        {
          ...existing,
          ...updatePayload,
          alias: params.alias,
          config: updatePayload.config
            ? { ...existing.config, ...updatePayload.config }
            : existing.config
        } as IdentityProviderRepresentation
      )
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      alias: t.String({ description: 'Identity provider alias' })
    }),
    body: UpdateIdentityProviderRequest,
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update Identity Provider',
      description: 'Update an identity provider by alias',
      tags: ['identity-providers']
    }
  })

  .delete('/:alias', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      // Extract user's token from Authorization header
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Authorization header required' }
      }

      const admin = await getAdmin(token)
      await admin.identityProviders.del({ alias: params.alias })
      return { success: true }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      alias: t.String({ description: 'Identity provider alias' })
    }),
    response: {
      200: SuccessResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Delete Identity Provider',
      description: 'Delete an identity provider by alias',
      tags: ['identity-providers']
    }
  })
