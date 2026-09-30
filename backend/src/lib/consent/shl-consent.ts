// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SHL → Consent mirror
 *
 * A SMART Health Link (SHL) is a patient-initiated data share, i.e. a consent
 * grant. To surface active shares in the consent portal (and evaluate them in
 * the enforcement engine) alongside every other consent, we mirror each minted
 * SHL into a FHIR `Consent` conforming to the `MaxHealthShareConsent` profile
 * (see fhir/input/fsh/consent.fsh, generated into maxhealth.consent-*-generated).
 *
 * Revocation runs through this Consent: the consent portal flips its status to
 * `inactive` (a standard FHIR update) and the SHL proxy denies access once the
 * backing Consent is non-active. Because revocation now depends on the Consent
 * existing, the mirror is written with retries and an idempotent conditional
 * create, sessions are marked once mirrored, and a reconciliation sweep
 * (`reconcileShareConsents`) repairs any that still slipped through. A mint-time
 * failure never blocks SHL creation — the sweep catches it.
 *
 * Revocation-by-expiry is automatic: the Consent's `provision.period.end` equals
 * the SHL's `expiresAt`, so an expired share is already inactive by period.
 */
import type { MaxHealthShareConsent } from '@proxy-smart/consent-fhir'
import { validateMaxHealthShareConsent } from '@proxy-smart/consent-fhir'
// Subpath import: the generated package exposes individual ValueSets under
// ./valuesets/* and only the registry at the root, same as the smart-app-launch
// package this repo already consumes that way (see lib/brand-bundle.ts).
import { MaxHealthConsentCategoryVSConcepts } from '@proxy-smart/consent-fhir/valuesets/ValueSet-MaxHealthConsentCategoryVS'
import { shlSessionStore, type ShlSession } from '@/lib/shl-session-store'
import { getServiceAccountToken, getDefaultFhirServerUrl, SHL_WRITE_SCOPE } from '@/lib/shl-service-account'
import { invalidateConsentCache } from '@/lib/consent/consent-service'
import { logger } from '@/lib/logger'

/**
 * Identifier system that ties a Consent back to its SHL session id.
 *
 * The IG fixes this exact value on `MaxHealthShareConsent.identifier[shlSession]`
 * (fhir/input/fsh/consent.fsh), so a drifted literal here fails
 * `validateMaxHealthShareConsent` rather than silently breaking revocation,
 * which resolves a share by matching this system. It stays a literal because a
 * NamingSystem produces no generated constant, and a ValueSet would be the wrong
 * artifact for an identifier system — `shl-consent.test.ts` pins the agreement.
 */
export const SHL_CONSENT_IDENTIFIER_SYSTEM = 'https://maxhealth.tech/fhir/shl-session'

/**
 * Category coding that marks a Consent as a SMART Health Link share, so UIs can
 * surface shares distinctly and filter them out of the practitioner-consent list.
 *
 * Sourced from the IG's generated ValueSet rather than retyped. The concepts are
 * a readonly tuple of string-literal types, so destructuring yields the system
 * and code fully typed with no assertion and no second copy to drift.
 */
const [SHARE_CATEGORY_CONCEPT] = MaxHealthConsentCategoryVSConcepts
export const SHL_CONSENT_CATEGORY_SYSTEM = SHARE_CATEGORY_CONCEPT.system
export const SHL_CONSENT_CATEGORY_CODE = SHARE_CATEGORY_CONCEPT.code

// Short-lived cache so the revocation check costs at most one FHIR round-trip
// per SHL per window, not one per proxied request. Revocation propagates within
// this window.
const REVOCATION_TTL_MS = 30_000
const revocationCache = new Map<string, { revoked: boolean; at: number }>()

const RESOURCE_TYPES_SYSTEM = 'http://hl7.org/fhir/resource-types'

/**
 * Resource classes the link exposes, as `provision.class` codings — set ONLY for
 * a study-scoped share (a single ImagingStudy). A whole-patient share returns
 * undefined so `class` is omitted (empty class = all resources), which the SHL
 * proxy scope filter enforces. We don't fabricate a resource-type list.
 */
function sharedClasses(session: ShlSession): { system: string; code: string }[] | undefined {
  if (!session.studyInstanceUID) return undefined
  return [{ system: RESOURCE_TYPES_SYSTEM, code: 'ImagingStudy' }]
}

/**
 * Build a `MaxHealthShareConsent` resource representing an SHL.
 * Pure: no I/O, no clock reads beyond the timestamps passed in via the session.
 */
export function buildShareConsent(shlId: string, session: ShlSession): MaxHealthShareConsent {
  const nowIso = new Date().toISOString()
  const patientRef = `Patient/${session.patientId}`
  const label = session.shl.label?.trim()
  // A named recipient is who the patient INTENDED, and it is what the consent
  // portal should show them — but it is still a bearer link, so the display says
  // both: the intent and the fact that anyone holding the link can act on it.
  const intended = session.recipientName?.trim()
  const holder = label ? `Any holder of the share link (${label})` : 'Any holder of the share link'
  const recipientDisplay = intended ? `${intended} — ${holder.toLowerCase()}` : holder
  const classes = sharedClasses(session)

  return {
    resourceType: 'Consent',
    status: 'active',
    identifier: [{ system: SHL_CONSENT_IDENTIFIER_SYSTEM, value: shlId }],
    scope: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }],
    },
    category: [
      {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/consentcategorycodes', code: '59284-0', display: 'Patient Consent' },
        ],
      },
      // Marks this consent as an SHL share so UIs can surface it distinctly.
      {
        coding: [{ system: SHL_CONSENT_CATEGORY_SYSTEM, code: SHL_CONSENT_CATEGORY_CODE, display: 'SMART Health Link share' }],
      },
    ],
    patient: { reference: patientRef },
    dateTime: nowIso,
    // The patient created the share.
    performer: [{ reference: patientRef }],
    // FHIR invariant ppc-1 requires a policy or policyRule. A patient-initiated
    // share is an opt-in consent directive.
    policyRule: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'OPTIN', display: 'opt-in' }],
    },
    provision: {
      type: 'permit',
      period: { start: nowIso, end: new Date(session.expiresAt).toISOString() },
      actor: [
        {
          role: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                code: 'IRCP',
                display: 'Information Recipient',
              },
            ],
          },
          // R4 requires actor.reference. A share has no Practitioner to point at —
          // even a named recipient is a label the patient typed — so the identity
          // travels as a display rather than a reference that would imply lookup.
          reference: { display: recipientDisplay },
        },
      ],
      // `access` always; `correct` as well when the share permits writing. Without
      // the second code an upload-capable link mirrors as a read-only grant, and
      // the consent portal — where the patient reviews and revokes — understates
      // what they gave away.
      action: [
        { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentaction', code: 'access' }] },
        ...(session.writeScope?.dicom
          ? [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentaction', code: 'correct', display: 'Correct/Update information' }] }]
          : []),
      ],
      ...(classes ? { class: classes } : {}),
    },
  }
}

/**
 * Has this SHL's backing Consent been revoked? True ONLY when a Consent tied to
 * this SHL id exists and its status is not `active` (e.g. the patient hit revoke
 * in the consent portal, flipping it to `inactive`). Fail-open: a missing mirror
 * or an unreachable FHIR server returns false so a best-effort mirror gap never
 * breaks an otherwise-valid share — the SHL session TTL remains the hard gate.
 */
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
      const bundle = (await resp.json().catch(() => null)) as { entry?: { resource?: { resourceType?: string; status?: string } }[] } | null
      const resource = bundle?.entry?.[0]?.resource
      if (resource?.resourceType === 'Consent' && resource.status && resource.status !== 'active') {
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
      // Idempotent create: never write a second Consent for the same SHL, so
      // retries and the reconciliation sweep can't produce duplicates.
      'If-None-Exist': `identifier=${SHL_CONSENT_IDENTIFIER_SYSTEM}|${shlId}`,
    },
    body: JSON.stringify(consent),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Consent write ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const created = (await resp.json().catch(() => null)) as { id?: string } | null
  return created?.id ?? null
}

/**
 * Mirror a minted SHL into a FHIR Consent, with retries and idempotent create.
 * Marks the session mirrored on success so the reconciliation sweep can skip it.
 * Never throws; returns the Consent id on success or null after exhausting retries
 * (the sweep will retry later — revocation depends on this Consent existing).
 */
export async function emitShareConsent(shlId: string, session: ShlSession): Promise<string | null> {
  const consent = buildShareConsent(shlId, session)

  // Compile-time conformance is enforced by the type; validate at runtime too
  // so profile drift surfaces as a warning rather than silently bad data.
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
      shlSessionStore.markConsentMirrored(shlId)
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

/**
 * Repair any active SHL sessions whose Consent mirror never landed (mint-time
 * failure, or shares minted before the mirror existed). Idempotent via the
 * conditional create; safe to run on a timer.
 */
export async function reconcileShareConsents(): Promise<void> {
  const pending = shlSessionStore.listUnmirroredActive(50)
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
