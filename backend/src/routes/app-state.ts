// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { config } from '../config'
import { validateToken } from '../lib/auth'
import { extractBearerToken } from '../lib/admin-utils'
import { logger } from '../lib/logger'
import type { AppStateCaller } from '../lib/app-state/context'
import { APP_STATE_PATH, appStateEndpointUrl, appStateFhirServers } from '../lib/app-state/endpoint'
import { fhirFailure } from '../lib/app-state/resource'
import { createAppStateService, type AppStateResponse, type AppStateService } from '../lib/app-state/service'
import { createAppStateBackend } from '../lib/app-state/store'
import { getAppStateRegistration } from '../lib/smart-client-config-cache'
import {
  AppStateBasic,
  AppStateBundle,
  AppStateCapabilityStatement,
  AppStateIdParam,
  FhirOperationOutcome,
} from '../schemas'

const FHIR_JSON = 'application/fhir+json; charset=utf-8'

function fhirResponse({ status, body, headers }: AppStateResponse): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': FHIR_JSON }), ...headers },
  })
}

function unauthorized(diagnostics: string, error?: string): Response {
  const response = fhirResponse({ status: 401, body: fhirFailure(401, 'login', diagnostics).outcome, headers: {} })
  response.headers.set('www-authenticate', error ? `Bearer error="${error}"` : 'Bearer')
  return response
}

async function authenticate(service: AppStateService, headers: Record<string, string | undefined>): Promise<AppStateCaller | Response> {
  const token = extractBearerToken(headers)
  if (!token) return unauthorized('An access token is required')
  let payload: Record<string, unknown>
  try {
    // Same policy as the FHIR proxy: aud is not enforced; when it names a FHIR server it binds the token's context to it.
    payload = await validateToken(token, { enforceAudience: false })
  } catch (error) {
    logger.fhir.warn('App State request with an invalid token', { error: error instanceof Error ? error.message : String(error) })
    return unauthorized('The access token is invalid or expired', 'invalid_token')
  }
  const caller = await service.caller(payload)
  return caller.ok ? caller.value : fhirResponse({ status: caller.status, body: caller.outcome, headers: {} })
}

const errorResponses = { 400: FhirOperationOutcome, 401: FhirOperationOutcome, 403: FhirOperationOutcome, 412: FhirOperationOutcome, 503: FhirOperationOutcome }

export function createAppStateRoutes(service: AppStateService) {
  return new Elysia({ prefix: APP_STATE_PATH, tags: ['smart-app-state'] })
    .get('/metadata', () => new Response(JSON.stringify(service.capabilityStatement()), {
      headers: { 'content-type': FHIR_JSON },
    }), {
      response: { 200: AppStateCapabilityStatement },
      detail: { summary: 'SMART App State CapabilityStatement', description: 'Describes the SMART App State endpoint (smart-app-state capability).' },
    })
    .get('/Basic', async ({ headers, request }) => {
      const caller = await authenticate(service, headers)
      if (caller instanceof Response) return caller
      return fhirResponse(await service.search(caller, new URL(request.url).search))
    }, {
      response: { 200: AppStateBundle, ...errorResponses },
      detail: {
        summary: 'Query SMART App State',
        description: 'GET /Basic?code={system|code}&subject={absolute reference}, or subject:missing=true for global app state.',
        security: [{ BearerAuth: [] }],
      },
    })
    .post('/Basic', async ({ headers, request }) => {
      const caller = await authenticate(service, headers)
      if (caller instanceof Response) return caller
      return fhirResponse(await service.create(caller, await request.text()))
    }, {
      parse: 'none',
      response: { 201: AppStateBasic, 413: FhirOperationOutcome, 422: FhirOperationOutcome, ...errorResponses },
      detail: { summary: 'Create SMART App State', description: 'Persist a Basic resource conforming to smart-app-state-basic.', security: [{ BearerAuth: [] }] },
    })
    .put('/Basic/:id', async ({ headers, params, request }) => {
      const caller = await authenticate(service, headers)
      if (caller instanceof Response) return caller
      return fhirResponse(await service.update(caller, params.id, request.headers.get('if-match'), await request.text()))
    }, {
      parse: 'none',
      params: AppStateIdParam,
      response: { 200: AppStateBasic, 413: FhirOperationOutcome, ...errorResponses },
      detail: { summary: 'Update SMART App State', description: 'Requires If-Match with the current ETag (400 without it, 412 when stale); code and subject cannot change.', security: [{ BearerAuth: [] }] },
    })
    .delete('/Basic/:id', async ({ headers, params, request }) => {
      const caller = await authenticate(service, headers)
      if (caller instanceof Response) return caller
      return fhirResponse(await service.remove(caller, params.id, request.headers.get('if-match')))
    }, {
      params: AppStateIdParam,
      response: errorResponses,
      detail: { summary: 'Delete SMART App State', description: 'Requires If-Match with the current ETag (400 without it, 412 when stale).', security: [{ BearerAuth: [] }] },
    })
}

export const appStateRoutes = createAppStateRoutes(createAppStateService({
  backend: createAppStateBackend(),
  registrations: getAppStateRegistration,
  endpointUrl: appStateEndpointUrl,
  fhirServers: appStateFhirServers,
  limits: () => config.appState,
}))
