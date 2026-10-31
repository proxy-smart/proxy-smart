// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ConsentProvision, ConsentProvisionActor, Period } from 'fhir/r4'
import { literalReferenceTarget } from '../fhir-reference'
import { normalizeFhirUser } from '../patient-context'
import type { ConsentDecision, ConsentR4, FhirConsent } from './types'

export interface ConsentRequest {
  clientId: string
  fhirUser: string | null
  resourceType: string | null
  read: boolean
  serverUrl: string
}

export type PeriodState = 'covers' | 'outside' | 'invalid'

const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/
const CONSENT_ACTION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentaction'
const READ_ACTIONS: ReadonlySet<string> = new Set(['access', 'use', 'disclose'])
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['correct'])
const CLIENT_ACTOR_TYPES: ReadonlySet<string> = new Set(['Device', 'Organization'])

function boundInstant(value: string, edge: 'start' | 'end'): number {
  const partial = PARTIAL_DATE.exec(value)
  if (!partial) return value.includes('T') ? Date.parse(value) : Number.NaN
  const year = Number(partial[1])
  const month = partial[2] ? Number(partial[2]) : edge === 'start' ? 1 : 12
  if (month < 1 || month > 12) return Number.NaN
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = partial[3] ? Number(partial[3]) : edge === 'start' ? 1 : daysInMonth
  if (day < 1 || day > daysInMonth) return Number.NaN
  return edge === 'start' ? Date.UTC(year, month - 1, day) : Date.UTC(year, month - 1, day, 23, 59, 59, 999)
}

/** A date-only or partial bound spans its whole day, month or year, as the consent portal writes it. */
export function periodCovers(period: Period | undefined, now: number = Date.now()): PeriodState {
  if (!period) return 'covers'
  const start = period.start === undefined ? -Infinity : boundInstant(period.start, 'start')
  const end = period.end === undefined ? Infinity : boundInstant(period.end, 'end')
  if (Number.isNaN(start) || Number.isNaN(end)) return 'invalid'
  return now >= start && now <= end ? 'covers' : 'outside'
}

export function isConsentRead(method: string, resourcePath: string): boolean {
  return method.toUpperCase() === 'GET' || resourcePath.includes('_search') || resourcePath.includes('$')
}

function namesRequester(actor: ConsentProvisionActor, request: ConsentRequest): boolean {
  const { reference, identifier } = actor.reference
  if (identifier?.value !== undefined && identifier.value === request.clientId) return true
  const target = reference ? literalReferenceTarget(reference, request.serverUrl) : null
  if (!target) return false
  if (CLIENT_ACTOR_TYPES.has(target.type)) return target.id === request.clientId
  return target.local && request.fhirUser !== null && normalizeFhirUser(request.fhirUser) === `${target.type}/${target.id}`
}

function coversClass(rule: ConsentProvision, resourceType: string | null, effective: ConsentDecision | undefined): boolean {
  const classes = rule.class ?? []
  if (classes.length === 0) return true
  if (!resourceType) return effective === 'deny'
  return classes.some((resourceClass) => resourceClass.code === resourceType)
}

function coversAction(rule: ConsentProvision, read: boolean): boolean {
  const actions = rule.action ?? []
  if (actions.length === 0) return true
  const wanted = read ? READ_ACTIONS : WRITE_ACTIONS
  return actions.some((concept) => (concept.coding ?? []).some((coding) =>
    (!coding.system || coding.system === CONSENT_ACTION_SYSTEM) && coding.code !== undefined && wanted.has(coding.code)))
}

function ruleOutcome(
  rule: ConsentProvision,
  request: ConsentRequest,
  now: number,
  inherited: ConsentDecision | undefined,
  named: boolean,
): ConsentDecision | null {
  const period = periodCovers(rule.period, now)
  if (period === 'invalid') return 'deny'
  const effective = rule.type ?? inherited
  if (period === 'outside' || !coversClass(rule, request.resourceType, effective) || !coversAction(rule, request.read)) return null
  const actors = rule.actor ?? []
  if (actors.length > 0 && !actors.some((actor) => namesRequester(actor, request))) return null
  const isNamed = named || actors.length > 0
  const nested = (rule.provision ?? []).map((child) => ruleOutcome(child, request, now, effective, isNamed))
  if (nested.includes('deny')) return 'deny'
  if (nested.includes('permit')) return 'permit'
  if (effective === 'permit' && !isNamed) return null
  return effective ?? null
}

function isR4Consent(consent: FhirConsent): consent is ConsentR4 {
  return !('decision' in consent) && !('except' in consent) && !('provision' in consent && Array.isArray(consent.provision))
}

/** What one Consent says about this request: a deny anywhere on the matching path wins, and a permit needs an actor naming the requester. */
export function consentRuling(consent: FhirConsent, request: ConsentRequest, now: number = Date.now()): ConsentDecision | null {
  if (consent.status !== 'active') return null
  if (!isR4Consent(consent)) return 'deny'
  if (!consent.provision) return null
  return ruleOutcome(consent.provision, request, now, undefined, false)
}
