// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** One FHIR AuditEvent per SHL manifest fetch, feeding the consent portal's access trail. Best-effort. */
import * as crypto from 'crypto'
import type { AuditEvent } from 'fhir/r4'
import { getShlAccessAgentTypeVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShlAccessAgentTypeVS'
import { getShlAccessAuditSubtypeVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShlAccessAuditSubtypeVS'
import { getShlAccessAuditTypeVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShlAccessAuditTypeVS'
import { getShlAccessEntityRoleVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShlAccessEntityRoleVS'
import { getShlAccessEntityTypeVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShlAccessEntityTypeVS'
import { shlSessionStore, type ShlSession } from '@/lib/shl-session-store'
import { getServiceAccountToken, getDefaultFhirServerUrl, SHL_WRITE_SCOPE } from '@/lib/shl-service-account'
import { SHL_CONSENT_IDENTIFIER_SYSTEM } from '@/lib/consent/shl-consent'
import { logger } from '@/lib/logger'

export interface ShlAccessContext {
  /** SHL id (also the backing Consent identifier value). */
  shlId: string
  session: ShlSession
  /** Recipient label from the manifest request, if provided. */
  recipient?: string
  /** Client IP, when resolvable from proxy headers. */
  ipAddress?: string
}

/** Build a FHIR R4 AuditEvent describing a single SHL open. */
export function buildShlAccessAuditEvent(ctx: ShlAccessContext): AuditEvent {
  const who = ctx.recipient?.trim() || 'Anonymous share-link recipient'
  return {
    resourceType: 'AuditEvent',
    type: { ...getShlAccessAuditTypeVSConcept('rest') },
    subtype: [{ ...getShlAccessAuditSubtypeVSConcept('read') }],
    action: 'R',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: 'SMART Health Link manifest accessed',
    agent: [
      {
        type: { coding: [{ ...getShlAccessAgentTypeVSConcept('IRCP') }] },
        who: { display: who },
        requestor: true,
        ...(ctx.ipAddress ? { network: { address: ctx.ipAddress, type: '2' } } : {}),
      },
    ],
    source: { observer: { display: 'proxy-smart SHL' } },
    entity: [
      {
        what: { reference: `Patient/${ctx.session.patientId}` },
        type: { ...getShlAccessEntityTypeVSConcept('1') },
        role: { ...getShlAccessEntityRoleVSConcept('1') },
      },
      {
        what: { identifier: { system: SHL_CONSENT_IDENTIFIER_SYSTEM, value: ctx.shlId } },
        type: { ...getShlAccessEntityTypeVSConcept('2') },
        name: 'SMART Health Link',
      },
    ],
  }
}

/** Record one SHL open: fingerprint (label + IP + user-agent) for distinct devices, then the AuditEvent. Never throws. */
export async function recordShlOpen(
  shlId: string,
  session: ShlSession,
  req: { recipient?: string; ipAddress?: string; userAgent?: string },
): Promise<void> {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${req.recipient ?? ''}|${req.ipAddress ?? ''}|${req.userAgent ?? ''}`)
    .digest('hex')
  shlSessionStore.recordAccess(shlId, fingerprint)
  await emitShlAccessAuditEvent({ shlId, session, recipient: req.recipient, ipAddress: req.ipAddress })
}

/** Emit an SHL-access AuditEvent to the FHIR server (best-effort — never throws). */
export async function emitShlAccessAuditEvent(ctx: ShlAccessContext): Promise<void> {
  try {
    const auditEvent = buildShlAccessAuditEvent(ctx)
    const fhirServerUrl = ctx.session.fhirServerUrl || (await getDefaultFhirServerUrl())
    const token = await getServiceAccountToken(SHL_WRITE_SCOPE)

    const resp = await fetch(`${fhirServerUrl}/AuditEvent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/fhir+json',
        Accept: 'application/fhir+json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(auditEvent),
    })

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      logger.auth.warn('SHL access AuditEvent write failed', { shlId: ctx.shlId, status: resp.status, detail: detail.slice(0, 300) })
    }
  } catch (error) {
    logger.auth.debug('SHL access AuditEvent error (best-effort)', { shlId: ctx.shlId, error: error instanceof Error ? error.message : String(error) })
  }
}
