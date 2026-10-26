// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Mirrors each minted SMART Health Link into a `MaxHealthShareConsent`, so shares surface, revoke
 * and audit like every other consent. Revocation flips the Consent to `inactive`; expiry is
 * `provision.period.end`. Writes retry with an idempotent conditional create, and
 * `reconcileShareConsents` repairs any mirror that never landed.
 */
import { type MaxHealthShareConsent, NamingSystemRegistry, validateMaxHealthShareConsent } from '@proxy-smart/consent-fhir'
import { getMaxHealthConsentCategoryVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-MaxHealthConsentCategoryVS'
import { getShareConsentActionVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShareConsentActionVS'
import { getShareConsentActorRoleVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShareConsentActorRoleVS'
import { getShareConsentDocumentCategoryVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShareConsentDocumentCategoryVS'
import { getShareConsentPolicyRuleVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShareConsentPolicyRuleVS'
import { getShareConsentScopeVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-ShareConsentScopeVS'
import { ValueSetRegistry } from '@max-health-inc/fhir-smart'
import { shlSessionStore, type ShlSession } from '@/lib/shl/session-store'
import { getServiceAccountToken, getDefaultFhirServerUrl, SHL_WRITE_SCOPE } from '@/lib/shl/service-account'
import { invalidateConsentCache } from '@/lib/consent/consent-service'
import { bundleResources, isFhirConsent } from '@/lib/consent/types'
import { logger } from '@/lib/logger'
import { isRecord, optionalString } from '@/lib/type-guards'

/** Ties a Consent to its SHL session id; revocation resolves a share by matching it. */
export const SHL_CONSENT_IDENTIFIER_SYSTEM = NamingSystemRegistry.MaxHealthShlSession.MaxHealthShlSessionSystem

/** Marks a Consent as an SHL share, so UIs can filter shares out of the practitioner-consent list. */
const SHARE_CATEGORY_CONCEPT = getMaxHealthConsentCategoryVSConcept('smart-health-link')
export const SHL_CONSENT_CATEGORY_SYSTEM = SHARE_CATEGORY_CONCEPT.system
export const SHL_CONSENT_CATEGORY_CODE = SHARE_CATEGORY_CONCEPT.code

// Revocation propagates within this window: at most one FHIR round-trip per SHL per window.
const REVOCATION_TTL_MS = 30_000
const revocationCache = new Map<string, { revoked: boolean; at: number }>()

/** `provision.class` for a study-scoped share only; a whole-patient share omits it (empty = all). */
function sharedClasses(session: ShlSession): { system: string; code: string }[] | undefined {
  if (!session.studyInstanceUID) return undefined
  return [{ ...ValueSetRegistry.ResourceTypes.getResourceTypesConcept('ImagingStudy') }]
}

/**
 * Build a `MaxHealthShareConsent` resource representing an SHL.
 * Pure: no I/O, no clock reads beyond the timestamps passed in via the session.
 */
export function buildShareConsent(shlId: string, session: ShlSession): MaxHealthShareConsent {
  const nowIso = new Date().toISOString()
  const patientRef = `Patient/${session.patientId}`
  const label = session.shl.label?.trim()
  // Still a bearer link: the display names the intended recipient and that any holder can act.
  const intended = session.recipientName?.trim()
  const holder = label ? `Any holder of the share link (${label})` : 'Any holder of the share link'
  const recipientDisplay = intended ? `${intended} — ${holder.toLowerCase()}` : holder
  const classes = sharedClasses(session)

  return {
    resourceType: 'Consent',
    status: 'active',
    identifier: [{ system: SHL_CONSENT_IDENTIFIER_SYSTEM, value: shlId }],
    scope: { coding: [{ ...getShareConsentScopeVSConcept('patient-privacy') }] },
    category: [
      { coding: [{ ...getShareConsentDocumentCategoryVSConcept('59284-0') }] },
      { coding: [{ ...SHARE_CATEGORY_CONCEPT }] },
    ],
    patient: { reference: patientRef },
    dateTime: nowIso,
    performer: [{ reference: patientRef }],
    // ppc-1 requires a policy or policyRule; a patient-initiated share is an opt-in directive.
    policyRule: { coding: [{ ...getShareConsentPolicyRuleVSConcept('OPTIN') }] },
    provision: {
      type: 'permit',
      period: { start: nowIso, end: new Date(session.expiresAt).toISOString() },
      actor: [
        {
          role: { coding: [{ ...getShareConsentActorRoleVSConcept('IRCP') }] },
          // R4 requires actor.reference; a share has no Practitioner, so the identity is a display.
          reference: { display: recipientDisplay },
        },
      ],
      // `correct` too when the link permits uploads, so the portal does not understate the grant.
      action: [
        { coding: [{ ...getShareConsentActionVSConcept('access') }] },
        ...(session.writeScope?.dicom ? [{ coding: [{ ...getShareConsentActionVSConcept('correct') }] }] : []),
      ],
      ...(classes ? { class: classes } : {}),
    },
  }
}

/** True only when this SHL's Consent exists and is not `active`. Fails open; the session TTL stays the hard gate. */
export async function isShareConsentRevoked(shlId: string, fhirServerUrl: string): Promise<boolean> {
  const cached = revocationCache.get(shlId)
  if (cached && Date.now() - cached.at < REVOCATION_TTL_MS) return cached.revoked

  let revoked = false
  try {
    const token = await getServiceAccountToken()
    const query = encodeURIComponent(`${SHL_CONSENT_IDENTIFIER_SYSTEM}|${shlId}`)
    const resp = await fetch(`${fhirServerUrl}/Consent?identifier=${query}&_count=1`, {
      headers: { Accept: 'application/fhir+json', Authorization: `Bearer ${token}` },
    })
    if (resp.ok) {
      const [consent] = bundleResources(await resp.json().catch(() => null), isFhirConsent)
      if (consent?.status && consent.status !== 'active') {
        revoked = true
      }
    }
  } catch (error) {
    logger.consent.debug('SHL revocation check failed (fail-open)', { shlId, error: error instanceof Error ? error.message : String(error) })
  }

  revocationCache.set(shlId, { revoked, at: Date.now() })
  return revoked
}

const MIRROR_MAX_ATTEMPTS = 3

/** One POST attempt. Returns the created id, or throws so the retry loop can back off. */
async function writeShareConsent(shlId: string, consent: MaxHealthShareConsent, fhirServerUrl: string): Promise<string | null> {
  const token = await getServiceAccountToken(SHL_WRITE_SCOPE)
  const resp = await fetch(`${fhirServerUrl}/Consent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/fhir+json',
      Accept: 'application/fhir+json',
      Authorization: `Bearer ${token}`,
      // Idempotent create, so retries and the sweep never write a second Consent.
      'If-None-Exist': `identifier=${SHL_CONSENT_IDENTIFIER_SYSTEM}|${shlId}`,
    },
    body: JSON.stringify(consent),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Consent write ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const created: unknown = await resp.json().catch(() => null)
  return isRecord(created) ? optionalString(created.id) ?? null : null
}

/** Mirror a minted SHL into a Consent with retries; never throws, returns the id or null for the sweep to retry. */
export async function emitShareConsent(shlId: string, session: ShlSession): Promise<string | null> {
  const consent = buildShareConsent(shlId, session)

  // Runtime validation too, so profile drift surfaces as a warning.
  try {
    const { errors } = await validateMaxHealthShareConsent(consent)
    if (errors.length) logger.consent.warn('SHL share consent failed profile validation', { shlId, errors })
  } catch (err) {
    logger.consent.debug('SHL share consent validation skipped', { shlId, error: err instanceof Error ? err.message : String(err) })
  }

  const fhirServerUrl = session.fhirServerUrl || (await getDefaultFhirServerUrl())

  for (let attempt = 1; attempt <= MIRROR_MAX_ATTEMPTS; attempt++) {
    try {
      const consentId = await writeShareConsent(shlId, consent, fhirServerUrl)
      await shlSessionStore.markConsentMirrored(shlId)
      invalidateConsentCache(session.patientId) // make the new active consent visible immediately
      logger.consent.info('SHL mirrored to Consent', { shlId, consentId, patientId: session.patientId })
      return consentId
    } catch (error) {
      const last = attempt === MIRROR_MAX_ATTEMPTS
      logger.consent[last ? 'warn' : 'debug'](`SHL share consent write attempt ${attempt} failed`, {
        shlId,
        error: error instanceof Error ? error.message : String(error),
        willRetry: !last,
      })
      if (last) return null
      await new Promise((r) => setTimeout(r, 200 * attempt)) // linear backoff
    }
  }
  return null
}

/** Mirror active SHL sessions whose Consent never landed. Idempotent; safe on a timer. */
export async function reconcileShareConsents(): Promise<void> {
  const pending = await shlSessionStore.listUnmirroredActive(50)
  if (!pending.length) return
  logger.consent.info('SHL consent reconciliation: mirroring pending shares', { count: pending.length })
  for (const { id, session } of pending) {
    await emitShareConsent(id, session)
  }
}

let reconcilerTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic Consent-mirror reconciliation sweep (idempotent to call). */
export function startShareConsentReconciler(intervalMs = 5 * 60_000): void {
  if (reconcilerTimer) return
  reconcilerTimer = setInterval(() => {
    reconcileShareConsents().catch((error) =>
      logger.consent.debug('SHL consent reconciliation error', { error: error instanceof Error ? error.message : String(error) }),
    )
  }, intervalMs)
  reconcilerTimer.unref?.()
}
