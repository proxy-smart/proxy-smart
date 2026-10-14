// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  PaginationQuery,
  SuccessResponse,
  CountResponse,
  Organization,
  CreateOrganizationRequest,
  UpdateOrganizationRequest,
  OrgIdParam,
  OrganizationMember,
  AddMemberRequest,
  OrgBrandConfig,
  OrgBrandConfigResponse,
  type ErrorResponseType,
  type SuccessResponseType,
  type OrganizationType,
  type OrganizationMemberType,
  type OrgBrandConfigResponseType,
} from '@/schemas'
import { extractBearerToken, UNAUTHORIZED_RESPONSE, getValidatedAdmin } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { logger } from '@/lib/logger'
import { getOrgBranding, saveOrgBranding } from '@/lib/org-branding'
import { brandBundleService } from '@/lib/brand-bundle'
import type OrganizationRepresentation from '@keycloak/keycloak-admin-client/lib/defs/organizationRepresentation'
import type MemberRepresentation from '@keycloak/keycloak-admin-client/lib/defs/memberRepresentation'

function toOrganization(org: OrganizationRepresentation): OrganizationType {
  return {
    id: org.id,
    name: org.name,
    alias: org.alias,
    description: org.description,
    redirectUrl: org.redirectUrl,
    enabled: org.enabled,
    attributes: org.attributes,
    domains: org.domains?.map(domain => ({ name: domain.name, verified: domain.verified })),
  }
}

function toOrganizationMember(member: MemberRepresentation): OrganizationMemberType {
  return {
    id: member.id,
    username: member.username,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    enabled: member.enabled,
    membershipType: member.membershipType,
  }
}

/**
 * Keycloak Organizations management routes
 * Provides CRUD for organizations plus member management
 */
export const organizationsRoutes = new Elysia({ prefix: '/organizations' })
  .use(keycloakPlugin)

  // ─── List organizations ───────────────────────────────────────
  .get('/', async ({ getAdmin, query, set, headers }): Promise<OrganizationType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      const orgs = await admin.organizations.find({
        first: Number(query.offset) || 0,
        max: Number(query.limit) || 50,
        ...(query.search ? { search: query.search } : {})
      })
      return orgs.map(toOrganization)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    query: t.Object({
      ...PaginationQuery.properties,
      search: t.Optional(t.String({ description: 'Search by name or domain' }))
    }),
    response: { 200: t.Array(Organization), ...CommonErrorResponses },
    detail: {
      summary: 'List Organizations',
      description: 'List all Keycloak organizations in the realm',
      tags: ['organizations']
    }
  })

  // ─── Count organizations ──────────────────────────────────────
  .get('/count', async ({ getAdmin, set, headers }) => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      const orgs = await admin.organizations.find()
      return { count: orgs.length, total: orgs.length }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: CountResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Count Organizations',
      description: 'Get the total number of organizations',
      tags: ['organizations']
    }
  })

  // ─── Get single organization ──────────────────────────────────
  .get('/:orgId', async ({ getAdmin, params, set, headers }): Promise<OrganizationType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      const org = await admin.organizations.findOne({ id: params.orgId })
      if (!org) { set.status = 404; return { error: 'Organization not found' } }
      return toOrganization(org)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    response: { 200: Organization, ...CommonErrorResponses },
    detail: {
      summary: 'Get Organization',
      description: 'Get a single organization by ID',
      tags: ['organizations']
    }
  })

  // ─── Create organization ──────────────────────────────────────
  .post('/', async ({ getAdmin, body, set, headers }): Promise<OrganizationType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      logger.admin.info('Creating organization', { name: body.name, alias: body.alias })
      const result = await admin.organizations.create(body)
      const created = await admin.organizations.findOne({ id: result.id })
      set.status = 201
      return toOrganization(created)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CreateOrganizationRequest,
    response: { 201: Organization, ...CommonErrorResponses },
    detail: {
      summary: 'Create Organization',
      description: 'Create a new Keycloak organization',
      tags: ['organizations']
    }
  })

  // ─── Update organization ──────────────────────────────────────
  .put('/:orgId', async ({ getAdmin, params, body, set, headers }): Promise<OrganizationType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      // Merge existing with updates
      const existing = await admin.organizations.findOne({ id: params.orgId })
      if (!existing) { set.status = 404; return { error: 'Organization not found' } }

      logger.admin.info('Updating organization', { id: params.orgId, name: body.name })
      await admin.organizations.updateById({ id: params.orgId }, { ...existing, ...body })
      const updated = await admin.organizations.findOne({ id: params.orgId })
      return toOrganization(updated)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    body: UpdateOrganizationRequest,
    response: { 200: Organization, ...CommonErrorResponses },
    detail: {
      summary: 'Update Organization',
      description: 'Update an existing organization',
      tags: ['organizations']
    }
  })

  // ─── Delete organization ──────────────────────────────────────
  .delete('/:orgId', async ({ getAdmin, params, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      logger.admin.info('Deleting organization', { id: params.orgId })
      await admin.organizations.delById({ id: params.orgId })
      return { success: true, message: 'Organization deleted' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Delete Organization',
      description: 'Delete an organization and all its managed members',
      tags: ['organizations']
    }
  })

  // ─── List members ─────────────────────────────────────────────
  .get('/:orgId/members', async ({ getAdmin, params, query, set, headers }): Promise<OrganizationMemberType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      const members = await admin.organizations.listMembers({
        orgId: params.orgId,
        first: Number(query.offset) || 0,
        max: Number(query.limit) || 50,
        ...(query.search ? { search: query.search } : {})
      })
      return members.map(toOrganizationMember)
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    query: t.Object({
      ...PaginationQuery.properties,
      search: t.Optional(t.String({ description: 'Search members by name or email' }))
    }),
    response: { 200: t.Array(OrganizationMember), ...CommonErrorResponses },
    detail: {
      summary: 'List Organization Members',
      description: 'List all members of an organization',
      tags: ['organizations']
    }
  })

  // ─── Add member ───────────────────────────────────────────────
  .post('/:orgId/members', async ({ getAdmin, params, body, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      logger.admin.info('Adding member to organization', { orgId: params.orgId, userId: body.userId })
      await admin.organizations.addMember({ orgId: params.orgId, userId: body.userId })
      return { success: true, message: 'Member added to organization' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    body: AddMemberRequest,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Add Member',
      description: 'Add an existing realm user as an organization member',
      tags: ['organizations']
    }
  })

  // ─── Remove member ────────────────────────────────────────────
  .delete('/:orgId/members/:userId', async ({ getAdmin, params, set, headers }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      logger.admin.info('Removing member from organization', { orgId: params.orgId, userId: params.userId })
      await admin.organizations.delMember({ orgId: params.orgId, userId: params.userId })
      return { success: true, message: 'Member removed from organization' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({
      orgId: t.String({ description: 'Organization ID' }),
      userId: t.String({ description: 'User ID to remove' })
    }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Remove Member',
      description: 'Remove a member from an organization',
      tags: ['organizations']
    }
  })

  // ─── Get org branding overrides ───────────────────────────────
  .get('/:orgId/branding', async ({ getAdmin, params, set, headers }): Promise<OrgBrandConfigResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      const config = await getOrgBranding(admin, params.orgId)
      return {
        message: 'Organization branding retrieved',
        orgId: params.orgId,
        config,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    response: { 200: OrgBrandConfigResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Get Organization Branding',
      description: 'Get per-organization brand overrides (fields not set cascade to realm defaults)',
      tags: ['organizations']
    }
  })

  // ─── Update org branding overrides ────────────────────────────
  .put('/:orgId/branding', async ({ getAdmin, params, body, set, headers }): Promise<OrgBrandConfigResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return UNAUTHORIZED_RESPONSE }
      const admin = await getValidatedAdmin(getAdmin, token)

      await saveOrgBranding(admin, params.orgId, body)
      brandBundleService.clearCache()

      const updated = await getOrgBranding(admin, params.orgId)
      return {
        message: 'Organization branding updated',
        orgId: params.orgId,
        config: updated,
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: OrgIdParam,
    body: OrgBrandConfig,
    response: { 200: OrgBrandConfigResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Update Organization Branding',
      description: 'Set per-organization brand overrides. Only provided fields are stored; omitted fields cascade to realm defaults.',
      tags: ['organizations']
    }
  })
