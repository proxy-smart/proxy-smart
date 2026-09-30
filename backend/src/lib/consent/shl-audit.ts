// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SHL access audit
 *
 * Emits a FHIR AuditEvent each time a recipient opens a SMART Health Link
 * (a manifest fetch). This is the FHIR-native home for "who accessed the shared
 * data and when" — distinct devices = distinct agents, total opens = event count
 * — complementing the fast counters in the SHL session store. It also feeds the
 * consent portal's access trail (AuditEvent), alongside the MaxHealthShareConsent
 * mirror (see shl-consent).
 *
 * Best-effort: a failure never blocks serving the manifest.
 */
import * as crypto from 'crypto'
import type { AuditEvent } from 'fhir/r4'
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
    type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'RESTful Operation' },
    subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: 'read', display: 'read' }],
    action: 'R',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: 'SMART Health Link manifest accessed',
    agent: [
      {
        type: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP', display: 'Information Recipient' }],
        },
        who: { display: who },
        requestor: true,
        ...(ctx.ipAddress ? { network: { address: ctx.ipAddress, type: '2' } } : {}),
      },
    ],
    source: { observer: { display: 'proxy-smart SHL' } },
    entity: [
      {
        what: { reference: `Patient/${ctx.session.patientId}` },
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '1', display: 'Person' },
        role: { system: 'http://terminology.hl7.org/CodeSystem/object-role', code: '1', display: 'Patient' },
      },
      {
        what: { identifier: { system: SHL_CONSENT_IDENTIFIER_SYSTEM, value: ctx.shlId } },
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '2', display: 'System Object' },
        name: 'SMART Health Link',
      },
    ],
  }
}

/**
 * Record one SHL open: track the (fingerprinted) recipient/device for the
 * distinct-devices count, then emit a FHIR access AuditEvent. Fingerprint =
 * recipient label + client IP + user-agent — a best-effort approximation of a
 * distinct recipient, since a bearer link has no real device identity.
 * Best-effort throughout; never throws.
 */
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
