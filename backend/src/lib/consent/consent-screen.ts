// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseTokenScopes } from '@proxy-smart/auth'
import { logger } from '../logger'
import { compartmentPatients } from '../patient-compartment/definition'
import { isRecord } from '../type-guards'
import { buildConsentContext, consentDecisionFor, getConsentConfig, isOwnRecord } from './consent-service'
import { screenAnswer, type ScreenedAnswer } from './screen-answer'
import type { ConsentConfig, SmartTokenPayload } from './types'

export interface ConsentScreenContext {
  tokenPayload: SmartTokenPayload
  serverName: string
  serverUrl: string
  referenceBase: string
  authHeader: string
  resourcePath: string
  method: string
}

const BROAD_CONTEXTS = ['user/', 'system/', 'agent/']
const CONSENT_DENIED = 'The patient has not granted this client access to their record.'

export function screensConsent(tokenPayload: SmartTokenPayload): boolean {
  return [...parseTokenScopes(tokenPayload)].some((scope) => BROAD_CONTEXTS.some((context) => scope.startsWith(context)))
}

function isRead(ctx: ConsentScreenContext): boolean {
  return ctx.method.toUpperCase() === 'GET' || ctx.resourcePath.includes('_search') || ctx.resourcePath.includes('$')
}

function governedPatients(resource: unknown, config: ConsentConfig, referenceBase: string): string[] {
  if (!isRecord(resource) || typeof resource.resourceType !== 'string') return []
  const type = resource.resourceType
  if (config.exemptResourceTypes.includes(type)) return []
  if (config.requiredForResourceTypes.length > 0 && !config.requiredForResourceTypes.includes(type)) return []
  return compartmentPatients(resource, referenceBase)
}

async function refusedPatients(ctx: ConsentScreenContext, config: ConsentConfig, patientIds: readonly string[]): Promise<Set<string>> {
  const refused = new Set<string>()
  if (patientIds.length === 0) return refused
  const base = await buildConsentContext(ctx.tokenPayload, ctx.serverName, ctx.resourcePath, ctx.method)
  if (config.exemptClients.includes(base.clientId)) return refused
  await Promise.all([...new Set(patientIds)].map(async (patientId) => {
    const context = { ...base, patientId }
    if (await isOwnRecord(context, ctx.serverUrl, ctx.authHeader)) return
    const { decision } = await consentDecisionFor(context, ctx.serverUrl, ctx.authHeader, config)
    if (decision !== 'permit') refused.add(patientId)
  }))
  return refused
}

export async function screenUnconsentedRecords(ctx: ConsentScreenContext, answer: ScreenedAnswer): Promise<ScreenedAnswer> {
  const config = getConsentConfig()
  if (!config.enabled || config.mode === 'disabled') return answer
  if (!isRead(ctx) || !screensConsent(ctx.tokenPayload)) return answer
  const enforce = config.mode === 'enforce'
  return screenAnswer(answer, {
    patientsOf: (resource) => governedPatients(resource, config, ctx.referenceBase),
    refusedAmong: (patientIds) => refusedPatients(ctx, config, patientIds),
    enforce,
    refusal: { status: 403, body: { error: 'consent_denied', message: CONSENT_DENIED } },
    unverifiable: answer,
    report: (detail) => logger.consent.warn('Records without consent taken out of an answer', { ...detail, server: ctx.serverName, wouldDeny: !enforce }),
  })
}
