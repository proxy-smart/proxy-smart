// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import type { Static, TSchema } from '@sinclair/typebox'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { keycloakPlugin } from './keycloak-plugin'
import { requireAdminClient, requireBearerToken } from './admin-utils'
import { handleAdminError } from './admin-error-handler'
import { validateToken } from './auth'
import { isRuntimeConfigLoaded, loadRuntimeConfig } from './runtime-config'
import { logger } from './logger'
import { CommonErrorResponses } from '@/schemas'

interface RouteDoc {
  summary: string
  description: string
}

export interface RuntimeSettingsSpec<S extends TSchema> {
  path: string
  label: string
  body: S
  response: TSchema
  read: () => Static<S>
  save: (admin: KcAdminClient, settings: Static<S>) => Promise<void>
  docs: { get: RouteDoc; put: RouteDoc }
}

/** GET/PUT pair for a settings group persisted in Keycloak realm attributes (lib/runtime-config). */
export function runtimeSettingsRoutes<S extends TSchema>(spec: RuntimeSettingsSpec<S>) {
  const detail = (doc: RouteDoc) => ({ ...doc, tags: ['admin'], security: [{ BearerAuth: [] }] })

  return new Elysia()
    .use(keycloakPlugin)
    .get(spec.path, async ({ getAdmin, headers, set }) => {
      try {
        await validateToken(requireBearerToken(headers))
        if (!isRuntimeConfigLoaded()) {
          await requireAdminClient({ getAdmin, headers })
            .then(loadRuntimeConfig)
            .catch((error: unknown) => logger.admin.warn('Runtime config not loaded, serving defaults', { error }))
        }
        return { message: `${spec.label} retrieved`, config: spec.read(), timestamp: new Date().toISOString() }
      } catch (error) {
        logger.admin.error(`Failed to get ${spec.label}`, { error })
        return handleAdminError(error, set)
      }
    }, {
      response: { 200: spec.response, ...CommonErrorResponses },
      detail: detail(spec.docs.get)
    })
    .put(spec.path, async ({ getAdmin, headers, body, set }) => {
      try {
        await spec.save(await requireAdminClient({ getAdmin, headers }), body)
        return { message: `${spec.label} updated`, config: spec.read(), timestamp: new Date().toISOString() }
      } catch (error) {
        logger.admin.error(`Failed to update ${spec.label}`, { error })
        return handleAdminError(error, set)
      }
    }, {
      body: spec.body,
      response: { 200: spec.response, ...CommonErrorResponses },
      detail: detail(spec.docs.put)
    })
}
