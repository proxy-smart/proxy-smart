// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The proxy's own consent for clients named by their metadata document. Keycloak remembers consent per client; the
 * CIMD draft (§10.12) requires it per client and resource, so the proxy asks and remembers it here instead.
 */

import { Elysia } from 'elysia'
import { continueLaunch, handleConsentDecision, isCimdClientId, resolveCimdDocument, type CallbackHandlerDeps, type LaunchSession } from '@proxy-smart/auth'
import { config } from '@/config'
import { createClientApprovalBackend, type ApprovalKey, type ClientApprovalBackend } from '@/lib/client-approvals'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { findSessionUserId } from '@/lib/kc-session-resolver'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { smartLogger } from '@/lib/smart-logger'
import { ConsentDecisionBody, PickerStepQuery } from '@/schemas'
import { authErrorPage } from '@/web/status-pages'
import { consentPage } from '@/web/consent-page'
import { displayName } from '../cimd-client'
import { findPickerSession, launchStepDeps, pickerSubmissionResponse } from './picker-support'

type ConsentPending = NonNullable<CallbackHandlerDeps['consentPending']>
type IdentifyUser = (clientId: string, sessionState: string) => Promise<string | null>

const requestedScopes = (scope: string | undefined): string[] => [...new Set((scope ?? '').split(' ').filter(Boolean))]

const approvalKey = (session: LaunchSession, userId: string): ApprovalKey =>
  ({ userId, clientId: session.clientId, resource: session.aud ?? '', redirectUri: session.clientRedirectUri })

async function keycloakSessionUser(clientId: string, sessionState: string): Promise<string | null> {
  const admin = await getAdminClient()
  return admin ? findSessionUserId(admin, clientId, sessionState) : null
}

export interface ConsentGate {
  consentPending: ConsentPending
  recordConsent: (session: LaunchSession & { consentUserId: string }) => Promise<void>
}

export function createConsentGate(approvals: ClientApprovalBackend, identifyUser: IdentifyUser, now: () => number = Date.now): ConsentGate {
  return {
    async consentPending(session, params) {
      if (!isCimdClientId(session.clientId)) return null
      const userId = params.session_state ? await identifyUser(session.clientId, params.session_state) : null
      if (!userId) return {}
      const approval = await approvals.find(approvalKey(session, userId))
      const approved = new Set(approval?.scopes ?? [])
      return approval && requestedScopes(session.scope).every((scope) => approved.has(scope)) ? null : { userId }
    },

    async recordConsent(session) {
      const key = approvalKey(session, session.consentUserId)
      const earlier = await approvals.find(key)
      await approvals.save({
        ...key,
        scopes: [...new Set([...(earlier?.scopes ?? []), ...requestedScopes(session.scope)])],
        approvedAt: now(),
      })
    },
  }
}

export const consentGate = createConsentGate(createClientApprovalBackend(), keycloakSessionUser)

const CONSENT_ACTION = '/auth/consent'

export const consentRoutes = new Elysia({ tags: ['authentication'] })

  .get('/consent', async ({ query }) => {
    const found = findPickerSession(query.session)
    if (!found.ok || !query.code) {
      return authErrorPage({
        status: found.ok ? 400 : found.status,
        error: found.ok ? 'invalid_request' : found.error,
        errorDescription: found.ok ? 'Missing code parameter' : found.error_description,
      })
    }
    const { key, session } = found.value
    // Already answered (browser back): go where the launch went, never ask twice.
    if (!session.needsConsent || !isCimdClientId(session.clientId)) {
      return pickerSubmissionResponse(continueLaunch(key, query.code, await launchStepDeps()), undefined)
    }
    const host = new URL(session.clientId).host
    const document = await resolveCimdDocument(session.clientId, { logger: smartLogger, urlPolicy: outboundUrlPolicy })
    return consentPage({
      clientName: displayName(session.clientId, document?.client_name),
      clientHost: host,
      clientId: session.clientId,
      resource: session.aud,
      redirectUri: session.clientRedirectUri,
      scopes: requestedScopes(session.scope),
      sessionKey: key,
      code: query.code,
      action: `${config.baseUrl}${CONSENT_ACTION}`,
    })
  }, {
    query: PickerStepQuery,
    detail: { summary: 'Consent Page', description: 'Asks the signed-in user to approve a client named by its metadata document for the requested resource.', tags: ['authentication'] },
  })

  .post('/consent', async ({ body, headers }) => {
    const deps = { ...(await launchStepDeps()), recordConsent: consentGate.recordConsent }
    return pickerSubmissionResponse(await handleConsentDecision(body, deps), headers['content-type'])
  }, {
    body: ConsentDecisionBody,
    detail: { summary: 'Consent Decision', description: 'Records the user\'s answer on the consent page; an approval is remembered for this client, resource and scopes.', tags: ['authentication'] },
  })
