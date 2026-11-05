// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t, type Static, type TSchema } from 'elysia'
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { CommonErrorResponses, SuccessResponse } from '@/schemas'
import { keycloakPlugin } from './keycloak-plugin'
import { requireAdminClient } from './admin-utils'
import { handleAdminError } from './admin-error-handler'
import { logger } from './logger'

/** A 404 or 409 a mapper store answers with its own message. */
export class MapperRequestError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message)
    this.name = 'MapperRequestError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface MapperStore<M extends TSchema, L extends TSchema, C extends TSchema, U extends TSchema> {
  list(admin: KcAdminClient, parent: string): Promise<Static<L>>
  create(admin: KcAdminClient, parent: string, body: Static<C>): Promise<Static<M>>
  update(admin: KcAdminClient, parent: string, mapperId: string, body: Static<U>): Promise<void>
  remove(admin: KcAdminClient, parent: string, mapperId: string): Promise<void>
}

type AdminResponseSet = Parameters<typeof handleAdminError>[1]

/** A store's own 404/409 as is; anything else is logged and mapped by handleAdminError. */
export function handleMapperError(error: unknown, set: AdminResponseSet, message: string, context: Record<string, string>) {
  if (error instanceof MapperRequestError) {
    set.status = error.status
    return { error: error.message }
  }
  logger.admin.error(message, { error, ...context })
  return handleAdminError(error, set)
}

interface RouteDoc {
  summary: string
  description: string
}

export interface MapperTypesSpec<T extends TSchema> {
  schema: T
  doc: RouteDoc
  list(admin: KcAdminClient, parent: string): Promise<Static<T>>
}

export interface MapperRoutesSpec<M extends TSchema, L extends TSchema, C extends TSchema, U extends TSchema, T extends TSchema> {
  prefix: string
  param: string
  paramDescription: string
  mapperIdDescription: string
  tag: string
  label: string
  schemas: { mapper: M; list: L; create: C; update: U }
  store: MapperStore<M, L, C, U>
  docs: { list: RouteDoc; create: RouteDoc; update: RouteDoc; remove: RouteDoc }
  types?: MapperTypesSpec<T>
}

/** List, create, update and delete for the mappers a Keycloak parent (IdP, LDAP provider, client) carries; reads need only read access. */
export function keycloakMapperRoutes<M extends TSchema, L extends TSchema, C extends TSchema, U extends TSchema, T extends TSchema = TSchema>(
  spec: MapperRoutesSpec<M, L, C, U, T>,
) {
  const parentParams = t.Object({ [spec.param]: t.String({ description: spec.paramDescription }) })
  const mapperParams = t.Object({
    [spec.param]: t.String({ description: spec.paramDescription }),
    mapperId: t.String({ description: spec.mapperIdDescription }),
  })
  const detail = (doc: RouteDoc) => ({ ...doc, tags: [spec.tag] })
  const base = `/:${spec.param}/mappers`

  const fail = (error: unknown, set: AdminResponseSet, action: string, context: Record<string, string>) =>
    handleMapperError(error, set, `Failed to ${action} ${spec.label}`, context)

  const routes = new Elysia({ prefix: spec.prefix })
    .use(keycloakPlugin)
    .get(base, async ({ getAdmin, params, headers, set }) => {
      const parent = params[spec.param]
      try {
        return await spec.store.list(await requireAdminClient({ getAdmin, headers }, 'read'), parent)
      } catch (error) {
        return fail(error, set, 'list', { [spec.param]: parent })
      }
    }, {
      params: parentParams,
      response: { 200: spec.schemas.list, ...CommonErrorResponses },
      detail: detail(spec.docs.list),
    })
    .post(base, async ({ getAdmin, params, body, headers, set }) => {
      const parent = params[spec.param]
      try {
        const created = await spec.store.create(await requireAdminClient({ getAdmin, headers }), parent, body)
        logger.admin.info(`Created ${spec.label}`, { [spec.param]: parent })
        return created
      } catch (error) {
        return fail(error, set, 'create', { [spec.param]: parent })
      }
    }, {
      params: parentParams,
      body: spec.schemas.create,
      response: { 200: spec.schemas.mapper, ...CommonErrorResponses },
      detail: detail(spec.docs.create),
    })
    .put(`${base}/:mapperId`, async ({ getAdmin, params, body, headers, set }) => {
      const parent = params[spec.param]
      try {
        await spec.store.update(await requireAdminClient({ getAdmin, headers }), parent, params.mapperId, body)
        logger.admin.info(`Updated ${spec.label}`, { [spec.param]: parent, mapperId: params.mapperId })
        return { success: true }
      } catch (error) {
        return fail(error, set, 'update', { [spec.param]: parent, mapperId: params.mapperId })
      }
    }, {
      params: mapperParams,
      body: spec.schemas.update,
      response: { 200: SuccessResponse, ...CommonErrorResponses },
      detail: detail(spec.docs.update),
    })
    .delete(`${base}/:mapperId`, async ({ getAdmin, params, headers, set }) => {
      const parent = params[spec.param]
      try {
        await spec.store.remove(await requireAdminClient({ getAdmin, headers }), parent, params.mapperId)
        logger.admin.info(`Deleted ${spec.label}`, { [spec.param]: parent, mapperId: params.mapperId })
        return { success: true }
      } catch (error) {
        return fail(error, set, 'delete', { [spec.param]: parent, mapperId: params.mapperId })
      }
    }, {
      params: mapperParams,
      response: { 200: SuccessResponse, ...CommonErrorResponses },
      detail: detail(spec.docs.remove),
    })

  const { types } = spec
  if (!types) return routes
  routes.get(`/:${spec.param}/mapper-types`, async ({ getAdmin, params, headers, set }) => {
    const parent = params[spec.param]
    try {
      return await types.list(await requireAdminClient({ getAdmin, headers }, 'read'), parent)
    } catch (error) {
      return fail(error, set, 'list mapper types of', { [spec.param]: parent })
    }
  }, {
    params: parentParams,
    response: { 200: types.schema, ...CommonErrorResponses },
    detail: detail(types.doc),
  })
  return routes
}
