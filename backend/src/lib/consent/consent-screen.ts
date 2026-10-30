// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseTokenScopes } from '@proxy-smart/auth'
import { logger } from '../logger'
import { compartmentPatients } from '../patient-compartment/definition'
import { isRecord } from '../type-guards'
import { buildConsentContext, consentDecisionFor, getConsentConfig, isOwnRecord } from './consent-service'
import type { ScreenedAnswer } from './record-custody'
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
  const { body } = answer
  if (!config.enabled || config.mode === 'disabled' || answer.status >= 300 || !isRecord(body)) return answer
  if (!isRead(ctx) || !screensConsent(ctx.tokenPayload)) return answer
  const enforce = config.mode === 'enforce'

  if (body.resourceType === 'Bundle') {
    const entries = Array.isArray(body.entry) ? body.entry : []
    const patientsOf = entries.map((entry) => (isRecord(entry) ? governedPatients(entry.resource, config, ctx.referenceBase) : []))
    const refused = await refusedPatients(ctx, config, patientsOf.flat())
    if (refused.size === 0) return answer
    const kept = entries.filter((_, i) => !patientsOf[i].some((id) => refused.has(id)))
    logger.consent.warn('Records without consent taken out of an answer', {
      removed: entries.length - kept.length, patients: refused.size, server: ctx.serverName, wouldDeny: !enforce,
    })
    return enforce ? { status: answer.status, body: { ...body, entry: kept } } : answer
  }

  const refused = await refusedPatients(ctx, config, governedPatients(body, config, ctx.referenceBase))
  if (refused.size === 0) return answer
  logger.consent.warn('A record without consent was read', { resourceType: body.resourceType, server: ctx.serverName, wouldDeny: !enforce })
  return enforce ? { status: 403, body: { error: 'consent_denied', message: CONSENT_DENIED } } : answer
}
