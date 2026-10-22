// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { extractBearerToken } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { toTokenEndpointAuthMethod } from '@/lib/auth-method-mapping'
import { isRealmAppClient } from '@/lib/realm-clients'
import {
  AuthFlow,
  AuthFlowExecution,
  AddExecutionRequest,
  UpdateExecutionRequest,
  AuthenticatorProvider,
  SmartFlowCard,
  type AuthFlowType,
  type AuthFlowExecutionType,
  type AuthenticatorProviderType,
  type SmartFlowCardType,
  type SmartFlowClientType,
} from '@/schemas/admin/auth-flows'
import {
  SuccessResponse,
  CommonErrorResponses,
  type SuccessResponseType,
  type ErrorResponseType,
} from '@/schemas'

/**
 * Authentication Flow Management
 *
 * Exposes Keycloak's authentication flow and execution configuration
 * so admins can inspect and modify client authentication strategies
 * (e.g. add federated-jwt to the clients flow).
 */
export const authFlowsRoutes = new Elysia({ prefix: '/auth-flows' })
  .use(keycloakPlugin)

  // ── List flows ─────────────────────────────────────────────────────────

  .get('/', async ({ getAdmin, headers, set }): Promise<AuthFlowType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const flows = await admin.authenticationManagement.getFlows()
      return flows.map(f => ({
        id: f.id,
        alias: f.alias,
        description: f.description,
        providerId: f.providerId,
        topLevel: f.topLevel,
        builtIn: f.builtIn,
      }))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: t.Array(AuthFlow), ...CommonErrorResponses },
    detail: { summary: 'List Authentication Flows', description: 'Get all authentication flows configured in the realm', tags: ['auth-flows'] },
  })

  // ── Get executions for a flow ──────────────────────────────────────────

  .get('/:flowAlias/executions', async ({ getAdmin, params, headers, set }): Promise<AuthFlowExecutionType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const executions = await admin.authenticationManagement.getExecutions({ flow: params.flowAlias })
      return executions.map(e => ({
        id: e.id,
        authenticator: e.providerId,
        displayName: e.displayName,
        requirement: e.requirement,
        requirementChoices: e.requirementChoices,
        configurable: e.configurable,
        authenticationFlow: e.authenticationFlow,
        flowId: e.flowId,
        alias: e.alias,
        level: e.level,
        index: e.index,
        providerId: e.providerId,
        authenticationConfig: e.authenticationConfig,
      }))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ flowAlias: t.String({ description: 'Flow alias (e.g. "clients", "browser")' }) }),
    response: { 200: t.Array(AuthFlowExecution), ...CommonErrorResponses },
    detail: { summary: 'Get Flow Executions', description: 'List all executions (authenticators) in an authentication flow', tags: ['auth-flows'] },
  })

  // ── Add execution to a flow ────────────────────────────────────────────

  .post('/:flowAlias/executions', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const { provider } = body

      await admin.authenticationManagement.addExecutionToFlow({
        flow: params.flowAlias,
        provider,
      })

      return { success: true, message: `Execution '${provider}' added to flow '${params.flowAlias}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ flowAlias: t.String({ description: 'Flow alias' }) }),
    body: AddExecutionRequest,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: { summary: 'Add Execution to Flow', description: 'Add an authenticator execution to an authentication flow', tags: ['auth-flows'] },
  })

  // ── Update execution requirement ───────────────────────────────────────

  .put('/:flowAlias/executions', async ({ getAdmin, params, body, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const { id, requirement } = body

      // KC's update requires the full execution object — fetch first
      const executions = await admin.authenticationManagement.getExecutions({ flow: params.flowAlias })
      const existing = executions.find(e => e.id === id)
      if (!existing) {
        set.status = 404
        return { error: `Execution '${id}' not found in flow '${params.flowAlias}'` }
      }

      await admin.authenticationManagement.updateExecution(
        { flow: params.flowAlias },
        { ...existing, requirement }
      )

      return { success: true, message: `Execution requirement updated to '${requirement}'` }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ flowAlias: t.String({ description: 'Flow alias' }) }),
    body: UpdateExecutionRequest,
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: { summary: 'Update Execution Requirement', description: 'Change the requirement (REQUIRED/ALTERNATIVE/DISABLED) of an execution in a flow', tags: ['auth-flows'] },
  })

  // ── Delete execution ───────────────────────────────────────────────────

  .delete('/executions/:executionId', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      await admin.authenticationManagement.delExecution({ id: params.executionId })
      return { success: true, message: 'Execution deleted' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ executionId: t.String({ description: 'Execution ID to delete' }) }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: { summary: 'Delete Execution', description: 'Remove an execution from its flow', tags: ['auth-flows'] },
  })

  // ── Reorder executions ─────────────────────────────────────────────────

  .post('/executions/:executionId/raise-priority', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      await admin.authenticationManagement.raisePriorityExecution({ id: params.executionId })
      return { success: true, message: 'Execution priority raised' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ executionId: t.String({ description: 'Execution ID' }) }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: { summary: 'Raise Execution Priority', description: 'Move an execution up in the flow', tags: ['auth-flows'] },
  })

  .post('/executions/:executionId/lower-priority', async ({ getAdmin, params, headers, set }): Promise<SuccessResponseType | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      await admin.authenticationManagement.lowerPriorityExecution({ id: params.executionId })
      return { success: true, message: 'Execution priority lowered' }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    params: t.Object({ executionId: t.String({ description: 'Execution ID' }) }),
    response: { 200: SuccessResponse, ...CommonErrorResponses },
    detail: { summary: 'Lower Execution Priority', description: 'Move an execution down in the flow', tags: ['auth-flows'] },
  })

  // ── Available authenticator providers ──────────────────────────────────

  .get('/client-authenticators', async ({ getAdmin, headers, set }): Promise<AuthenticatorProviderType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)
      const providers = await admin.authenticationManagement.getClientAuthenticatorProviders()
      return providers.map(p => ({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
      }))
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: t.Array(AuthenticatorProvider), ...CommonErrorResponses },
    detail: { summary: 'List Client Authenticator Providers', description: 'Get available client authenticator types (client-secret, client-jwt, federated-jwt, etc.)', tags: ['auth-flows'] },
  })

  // ── SMART flow mapping ─────────────────────────────────────────────────

  .get('/smart-flow-mapping', async ({ getAdmin, headers, set }): Promise<SmartFlowCardType[] | ErrorResponseType> => {
    try {
      const token = extractBearerToken(headers)
      if (!token) { set.status = 401; return { error: 'Authorization header required' } }

      const admin = await getAdmin(token)

      // Fetch clients and flows in parallel
      const [allClients, flows] = await Promise.all([
        admin.clients.find(),
        admin.authenticationManagement.getFlows(),
      ])

      // Fetch executions for browser and clients flows
      const browserFlow = flows.find(f => f.alias === 'browser')
      const clientsFlow = flows.find(f => f.alias === 'clients')

      const [browserExecs, clientsExecs] = await Promise.all([
        browserFlow ? admin.authenticationManagement.getExecutions({ flow: 'browser' }) : Promise.resolve([]),
        clientsFlow ? admin.authenticationManagement.getExecutions({ flow: 'clients' }) : Promise.resolve([]),
      ])

      const smartClients = allClients.filter(isRealmAppClient)

      // Classify clients into SMART flow types
      const ehrClients: SmartFlowClientType[] = []
      const standaloneClients: SmartFlowClientType[] = []
      const backendClients: SmartFlowClientType[] = []

      for (const client of smartClients) {
        const mapped: SmartFlowClientType = {
          clientId: client.clientId ?? '',
          name: client.name,
          enabled: client.enabled,
          publicClient: client.publicClient,
          tokenEndpointAuthMethod: toTokenEndpointAuthMethod(client),
          clientAuthenticatorType: client.clientAuthenticatorType,
        }

        if (client.serviceAccountsEnabled && !client.standardFlowEnabled) {
          backendClients.push(mapped)
        } else if (client.standardFlowEnabled) {
          // EHR Launch: apps with launch scope capability (has 'launch' in scopes or has launch_url)
          const hasLaunchAttr = client.attributes?.['launch_url'] || client.attributes?.['client_type'] === 'ehr-launch'
          if (hasLaunchAttr) {
            ehrClients.push(mapped)
          }
          // All standard-flow clients support standalone launch
          standaloneClients.push(mapped)
        }
      }

      // Build execution step descriptions from actual KC data
      const browserSteps = browserExecs
        .filter(e => !e.authenticationFlow && e.requirement !== 'DISABLED')
        .map(e => e.displayName || e.providerId || 'unknown')

      const clientsSteps = clientsExecs
        .filter(e => !e.authenticationFlow && e.requirement !== 'DISABLED')
        .map(e => e.displayName || e.providerId || 'unknown')

      const cards: SmartFlowCardType[] = [
        {
          flowType: 'ehr-launch',
          title: 'EHR Launch',
          description: 'Application launched from within an EHR with pre-selected patient/encounter context via a launch code.',
          oauthGrant: 'authorization_code',
          steps: [
            { label: 'Launch Code', description: 'EHR provides a launch code with patient/encounter context' },
            { label: 'Authorize', kcFlow: 'browser', description: `User authenticates via KC browser flow (${browserSteps.join(', ') || 'N/A'})` },
            { label: 'Callback', description: 'Proxy validates session and forwards authorization code' },
            { label: 'Token Exchange', kcFlow: 'clients', kcExecution: clientsSteps[0], description: `Client authenticates via KC clients flow (${clientsSteps.join(', ') || 'N/A'})` },
            { label: 'Context Enrichment', description: 'Proxy enriches token with patient, encounter, fhirUser from launch context' },
          ],
          clients: ehrClients,
          kcFlows: ['browser', 'clients'],
        },
        {
          flowType: 'standalone-launch',
          title: 'Standalone Launch',
          description: 'Application launches independently. User selects patient via patient picker if launch/patient scope is requested.',
          oauthGrant: 'authorization_code',
          steps: [
            { label: 'Authorize', kcFlow: 'browser', description: `User authenticates via KC browser flow (${browserSteps.join(', ') || 'N/A'})` },
            { label: 'Patient Picker', description: 'Proxy gates on patient selection if launch/patient scope is requested' },
            { label: 'Callback', description: 'Proxy validates session and forwards authorization code' },
            { label: 'Token Exchange', kcFlow: 'clients', kcExecution: clientsSteps[0], description: `Client authenticates via KC clients flow (${clientsSteps.join(', ') || 'N/A'})` },
            { label: 'Context Enrichment', description: 'Proxy enriches token with patient, fhirUser from session' },
          ],
          clients: standaloneClients,
          kcFlows: ['browser', 'clients'],
        },
        {
          flowType: 'backend-services',
          title: 'Backend Services',
          description: 'System-to-system access with no user interaction. Client authenticates with a signed JWT assertion (client_credentials grant).',
          oauthGrant: 'client_credentials',
          steps: [
            { label: 'JWT Assertion', description: 'Client signs a JWT with its private key and sends to token endpoint' },
            { label: 'Client Authentication', kcFlow: 'clients', kcExecution: clientsSteps[0], description: `Proxy validates JWT, then authenticates to KC (${clientsSteps.join(', ') || 'N/A'})` },
            { label: 'Token Issued', description: 'Access token with system/* scopes — no patient context' },
          ],
          clients: backendClients,
          kcFlows: ['clients'],
        },
      ]

      return cards
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    response: { 200: t.Array(SmartFlowCard), ...CommonErrorResponses },
    detail: { summary: 'SMART Flow Mapping', description: 'Get SMART on FHIR flow types with their KC flow mappings and classified clients', tags: ['auth-flows'] },
  })
