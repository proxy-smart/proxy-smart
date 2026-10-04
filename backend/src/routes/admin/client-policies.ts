// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import {
  CommonErrorResponses,
  ClientProfilesResponse,
  ClientProfile,
  ClientPoliciesResponse,
  ClientPolicy,
  CimdSetupRequest,
  CimdSetupResponse,
  CimdStatusResponse,
  type ClientProfilesResponseType,
  type ClientPoliciesResponseType,
  type CimdSetupResponseType,
  type CimdStatusResponseType,
  type ErrorResponseType,
} from '@/schemas'
import { handleAdminError } from '@/lib/admin-error-handler'
import { extractBearerToken } from '@/lib/admin-utils'
import { logger } from '@/lib/logger'
import { applyCimdPolicy, readCimdStatus } from '@/lib/cimd-policy'


/**
 * Client Policies & CIMD Management
 *
 * Wraps Keycloak's client-policies admin API and provides a convenience
 * endpoint for one-click CIMD (OAuth Client ID Metadata Document) setup.
 */
export const clientPoliciesRoutes = new Elysia({ prefix: '/client-policies', tags: ['client-policies'] })
  .use(keycloakPlugin)

  // ── Profiles CRUD ────────────────────────────────────────────────────────

  .get('/profiles', async ({ getAdmin, headers, set, query }): Promise<ClientProfilesResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const includeGlobal = query.includeGlobal === 'true'
      const result = await admin.clientPolicies.listProfiles({ includeGlobalProfiles: includeGlobal })
      return result as ClientProfilesResponseType
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    query: t.Object({
      includeGlobal: t.Optional(t.String({ description: 'Include global built-in profiles ("true"/"false")' })),
    }),
    response: { 200: ClientProfilesResponse, ...CommonErrorResponses },
    detail: {
      summary: 'List Client Profiles',
      description: 'List all client profiles (optionally including built-in global profiles)',
      tags: ['client-policies'],
    },
  })

  .put('/profiles', async ({ getAdmin, headers, set, body }): Promise<ClientProfilesResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      // Keycloak PUT replaces the full list — merge with existing to avoid wiping
      const existing = await admin.clientPolicies.listProfiles({ includeGlobalProfiles: false })
      const existingProfiles = existing.profiles || []

      // Merge: update by name, or append new
      const updated = [...existingProfiles]
      for (const incoming of body.profiles || []) {
        const idx = updated.findIndex(p => p.name === incoming.name)
        if (idx >= 0) updated[idx] = incoming
        else updated.push(incoming)
      }

      await admin.clientPolicies.createProfiles({ profiles: updated })
      const result = await admin.clientPolicies.listProfiles({ includeGlobalProfiles: false })
      return result as ClientProfilesResponseType
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: t.Object({ profiles: t.Array(ClientProfile) }),
    response: { 200: ClientProfilesResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Update Client Profiles',
      description: 'Create or update client profiles (merges with existing by name)',
      tags: ['client-policies'],
    },
  })

  // ── Policies CRUD ────────────────────────────────────────────────────────

  .get('/policies', async ({ getAdmin, headers, set, query }): Promise<ClientPoliciesResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const includeGlobal = query.includeGlobal === 'true'
      const result = await admin.clientPolicies.listPolicies({ includeGlobalPolicies: includeGlobal })
      return result as ClientPoliciesResponseType
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    query: t.Object({
      includeGlobal: t.Optional(t.String({ description: 'Include global built-in policies ("true"/"false")' })),
    }),
    response: { 200: ClientPoliciesResponse, ...CommonErrorResponses },
    detail: {
      summary: 'List Client Policies',
      description: 'List all client policies (optionally including built-in global policies)',
      tags: ['client-policies'],
    },
  })

  .put('/policies', async ({ getAdmin, headers, set, body }): Promise<ClientPoliciesResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const existing = await admin.clientPolicies.listPolicies({ includeGlobalPolicies: false })
      const existingPolicies = existing.policies || []

      const updated = [...existingPolicies]
      for (const incoming of body.policies || []) {
        const idx = updated.findIndex(p => p.name === incoming.name)
        if (idx >= 0) updated[idx] = incoming
        else updated.push(incoming)
      }

      await admin.clientPolicies.updatePolicy({ policies: updated })
      const result = await admin.clientPolicies.listPolicies({ includeGlobalPolicies: false })
      return result as ClientPoliciesResponseType
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: t.Object({ policies: t.Array(ClientPolicy) }),
    response: { 200: ClientPoliciesResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Update Client Policies',
      description: 'Create or update client policies (merges with existing by name)',
      tags: ['client-policies'],
    },
  })

  // ── CIMD Convenience Endpoints ───────────────────────────────────────────

  .get('/cimd/status', async ({ getAdmin, headers, set }): Promise<CimdStatusResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }
      return await readCimdStatus(await getAdmin(token))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: CimdStatusResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Get CIMD Status',
      description: 'Check whether CIMD (OAuth Client ID Metadata Document) is configured and active',
      tags: ['client-policies'],
    },
  })

  .post('/cimd/configure', async ({ getAdmin, headers, set, body }): Promise<CimdSetupResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      logger.admin.info('Configuring CIMD client policy', { trustedDomains: body.trustedDomains })
      const { profileName, policyName } = await applyCimdPolicy(await getAdmin(token), body)
      logger.admin.info('CIMD configured successfully', { profileName, policyName, trustedDomains: body.trustedDomains })

      return {
        success: true,
        message: `CIMD configured: profile "${profileName}" + policy "${policyName}" with trusted domains [${body.trustedDomains.join(', ')}]`,
        profileName,
        policyName,
        trustedDomains: body.trustedDomains,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: CimdSetupRequest,
    response: { 200: CimdSetupResponse, ...CommonErrorResponses },
    detail: {
      summary: 'Configure CIMD',
      description: 'One-click setup of OAuth Client ID Metadata Document (CIMD) for MCP 2025-11-25. Creates/updates the Keycloak client profile + policy for CIMD processing.',
      tags: ['client-policies'],
    },
  })
