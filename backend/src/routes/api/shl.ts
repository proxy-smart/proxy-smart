// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Health Links (SHL) API Routes — Proxy Architecture
 *
 * Spec-compliant SHL creation and manifest serving for QR-based patient data sharing.
 * Uses kill-the-clipboard for JWE encryption (alg:dir, enc:A256GCM) and SHL URI generation.
 *
 * PROXY PATTERN: No real tokens leave the server. The SHL manifest contains an opaque
 * session token + aud pointing to /api/shl/fhir. The viewer calls our FHIR proxy,
 * and the backend uses a Keycloak service account to fetch data from the real FHIR server.
 *
 * Content type: application/smart-api-access (SMART Access Token Response)
 * @see https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html
 */

import { Elysia, t } from 'elysia'
import { SHL, encryptSHLFile, type SHLFileContentType } from 'kill-the-clipboard'
import { config } from '@/config'
import { authenticatePatientCaller } from './patient-caller'
import { authorizeShlBearer, sessionSelectiveScope, shlDicomwebProxyHandler, shlFhirProxyHandler } from './shl-proxy'
import { logger } from '@/lib/logger'
import { clientIp } from '@/lib/client-ip'
import { getDefaultFhirServer } from '@/lib/shl/service-account'
import { emitShareConsent, isShareConsentRevoked } from '@/lib/consent/shl-consent'
import { recordShlOpen } from '@/lib/consent/shl-audit'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { shortenUrl } from '@/lib/url-shortener'
import { getPublishedApps } from '@/lib/app-store-config'
import { resolveClientLaunchUrl, resolveShlViewerBase } from '@/lib/client-launch-url'
import { shlSessionStore, type ShareScope, type ShlAttestation, type ShlWriteScope } from '@/lib/shl/session-store'
import { isCompleteShare, shareQueryHints } from '@/lib/shl/scope'
import * as crypto from 'crypto'
import { sha256 } from '@/lib/hash'

// KTC doesn't support smart-api-access yet (in their Future Work).
// The JWE format is identical — just a different cty header string.
const SMART_API_ACCESS = 'application/smart-api-access' as SHLFileContentType

// ── Route schemas ───────────────────────────────────────────────────────────

const ErrorResponse = t.Object({ error: t.String() })

const CreateShlBody = t.Object({
  label: t.Optional(t.String({ description: 'Label shown to recipient' })),
  passcode: t.Optional(t.String({ description: 'Optional passcode to protect the SHL' })),
  expiresInMinutes: t.Optional(t.Number({ description: 'Expiry in minutes (default 60, max 4320 = 72h)', default: 60, minimum: 1 })),
  verifiedOnly: t.Optional(t.Boolean({ description: 'Whether to include only verified resources', default: false })),
  shareScope: t.Optional(t.Object({
    excludedTypes: t.Optional(t.Array(t.String(), { description: 'FHIR resource types fully hidden from the recipient (a whole category was deselected)' })),
    excludedIds: t.Optional(t.Array(t.String(), { description: 'Individually hidden resources as "ResourceType/id"' })),
    excludedObservationCategories: t.Optional(t.Array(t.String(), { description: 'Observation category codes fully hidden (e.g. vital-signs, laboratory)' })),
  }, { description: 'Selective sharing: the patient de-selected some records/categories. Omit (or leave empty) to share everything.' })),
  studyInstanceUID: t.Optional(t.String({ description: 'DICOM Study Instance UID — scope the SHL to a single imaging study' })),
  writeScope: t.Optional(t.Object({
    dicom: t.Optional(t.Boolean({ description: 'Let the recipient STOW DICOM instances for this patient' })),
  }, { description: 'What the recipient may WRITE. Omit for a read-only share, which is the default and what every share was before this existed. Granted per kind: letting a radiology department add imaging is not the same as letting them write observations.' })),
  recipientName: t.Optional(t.String({ description: 'Who the patient says the link is for, e.g. "Dr. Müller". A LABEL, not an identity — an SHL is a bearer link, so whoever holds it can claim to be this person. Omit and the recipient enters their own name when they sign.', maxLength: 200 })),
  shortenUrl: t.Optional(t.Boolean({ description: 'Opt-in: shorten the viewer URL via go.maxhealth.tech (stored securely, auto-expires)', default: false })),
  maxUses: t.Optional(t.Number({ description: 'Maximum number of times the shortened URL can be accessed before expiring (only when shortenUrl is true)', minimum: 1 })),
})

const ShlResponse = t.Object({
  shlinkPayload: t.String({ description: 'Base64url-encoded SHL payload for QR encoding' }),
  viewerUrl: t.String({ description: 'Full URL for QR code (viewer app with SHL in hash)' }),
  shortUrl: t.Optional(t.String({ description: 'Shortened viewer URL via go.maxhealth.tech (if available)' })),
  expiresAt: t.String({ description: 'ISO 8601 expiry timestamp' }),
})

const ManifestRequest = t.Object({
  recipient: t.Optional(t.String({ description: 'Recipient identifier (for audit)' })),
  passcode: t.Optional(t.String({ description: 'Passcode if SHL is passcode-protected' })),
  embeddedLengthMax: t.Optional(t.Number({ description: 'Max embedded payload size in bytes' })),
})

/**
 * The smart-api-access document the recipient decrypts (SHL spec §3.2).
 *
 * Derived from the session on every manifest fetch rather than frozen at mint,
 * because what it asserts — how long the token is good for, what the share covers
 * — are properties of the share as it stands now. Freezing them meant a link kept
 * telling recipients it carried the full record after the rule deciding that was
 * corrected, since the claim sat inside ciphertext minted days earlier. It is also
 * why links already in circulation pick up `query` without being re-minted.
 */
export function buildSmartApiAccess(session: {
  sessionToken: string
  patientId: string
  expiresAt: number
  shareScope?: ShareScope
  studyInstanceUID?: string
  writeScope?: ShlWriteScope
  recipientName?: string
  attestation?: ShlAttestation
}): string {
  const selectiveScope = sessionSelectiveScope(session)
  return JSON.stringify({
    access_token: session.sessionToken,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
    scope: 'patient/*.read',
    patient: session.patientId,
    // aud points to our FHIR proxy — the viewer never talks to the real FHIR server.
    aud: `${config.baseUrl}/api/shl/fhir`,
    // Spec field. Undefined drops out of the JSON, which is the "no hints" case.
    query: shareQueryHints({ studyInstanceUID: session.studyInstanceUID }),
    // Ours. Only `true` carries meaning — see isCompleteShare.
    complete: isCompleteShare({
      selectiveScope,
      studyInstanceUID: session.studyInstanceUID,
    }),
    // Ours. What the recipient may write, and what they must do first.
    //
    // `scope` above stays `patient/*.read` and that is not an oversight: it is a
    // SMART scope string describing FHIR access, and DICOM upload is not a FHIR
    // operation. Overloading it would tell every reader something untrue about
    // the FHIR API. Undefined drops out of the JSON, so a read-only share is
    // byte-identical to what it was before write access existed.
    upload: session.writeScope?.dicom ? { dicom: true } : undefined,
    // So the signing step can show the name the patient chose, or ask for one.
    recipientName: session.recipientName,
    // Whether a signature is already on file for this session.
    attested: session.attestation ? true : undefined,
  })
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const shlRoutes = new Elysia({ prefix: '/shl', tags: ['shl'] })

  /**
   * Create a new SMART Health Link.
   * Generates an opaque proxy session — no real tokens leave the server.
   */
  .post('/', async ({ body, headers, set }) => {
    try {
      const caller = await authenticatePatientCaller(headers, set, 'SHL mint')
      if ('error' in caller) return caller
      const { payload: tokenPayload, patientId } = caller

      const expiresInMinutes = Math.max(1, Math.min(body.expiresInMinutes ?? 60, 4320)) // min 1m, max 72h
      const ttlSeconds = expiresInMinutes * 60
      const expiresAt = Date.now() + ttlSeconds * 1000

      const fhirServer = await getDefaultFhirServer()

      // Generate opaque session token (256-bit, base64url-encoded)
      const sessionToken = crypto.randomBytes(32).toString('base64url')

      const fhirServerUrl = fhirServer.url

      // Normalize the selective-sharing scope. Persist it only when it actually
      // narrows the share; an omitted or all-empty scope stays undefined so the
      // proxy takes the untouched "share everything" path.
      const excludedTypes = body.shareScope?.excludedTypes ?? []
      const excludedIds = body.shareScope?.excludedIds ?? []
      const excludedObservationCategories = body.shareScope?.excludedObservationCategories ?? []
      const shareScope: ShareScope | undefined =
        excludedTypes.length + excludedIds.length + excludedObservationCategories.length > 0
          ? { excludedTypes, excludedIds, excludedObservationCategories }
          : undefined

      // The same document the manifest re-derives on every fetch — built once here
      // so a freshly minted link and a later fetch cannot disagree. `complete` is a
      // non-standard hint for our own viewer, readable only by the key holder (JWE).
      const smartApiAccess = buildSmartApiAccess({
        sessionToken,
        patientId,
        expiresAt,
        shareScope,
        studyInstanceUID: body.studyInstanceUID,
      })

      // Generate SHL using kill-the-clipboard
      const shlId = crypto.randomUUID()
      const shl = SHL.generate({
        id: shlId,
        baseManifestURL: `${config.baseUrl}/api/shl/`,
        manifestPath: shlId,
        expirationDate: new Date(expiresAt),
        flag: body.passcode ? 'P' : undefined,
        label: body.label,
      })

      // JWE-encrypt the token response using SHL's key (spec: alg:dir, enc:A256GCM)
      const jwe = await encryptSHLFile({
        content: smartApiAccess,
        key: shl.key,
        contentType: SMART_API_ACCESS,
      })

      const passcodeHash = body.passcode
        ? sha256(body.passcode)
        : undefined

      // Store session (proxy token → patient data mapping, no real tokens)
      const session = {
        shl: shl.payload,
        jwe,
        sessionToken,
        patientId,
        studyInstanceUID: body.studyInstanceUID,
        fhirServerUrl,
        expiresAt,
        verifiedOnly: body.verifiedOnly ?? false,
        shareScope,
        // Only a scope that actually grants something is stored: `{}` and `{ dicom: false }`
        // both mean read-only, and persisting them would make a read-only share look
        // like a write-enabled one to anything inspecting the session.
        writeScope: body.writeScope?.dicom ? { dicom: true } : undefined,
        recipientName: body.recipientName?.trim() || undefined,
        accessCount: 0,
        passcodeHash,
      }
      await shlSessionStore.set(shlId, session)

      // Mirror the share into a FHIR Consent so active SHLs surface in the
      // consent portal alongside every other grant. Best-effort: never blocks
      // SHL creation (see @/lib/consent/shl-consent).
      await emitShareConsent(shlId, session)

      // Build the SHL URI and viewer URL.
      // Open the recipient in the SMART app that MINTED the share, at that app's
      // registered launch URL — so a per-study share minted by the DICOM viewer
      // opens in the viewer itself instead of an almost-empty patient portal.
      // The launch URL lives on the app's Keycloak client (`launch_url`, set via
      // Smart Apps); prefer that, then a published app-store entry, then the
      // patient portal. No per-env config or manual publish needed.
      const shlinkURI = shl.toURI()
      const shlinkPayload = shlinkURI.replace('shlink:/', '')
      const creatingClient = String(tokenPayload.azp ?? tokenPayload.client_id ?? '')
      const launchUrl =
        (await resolveClientLaunchUrl(creatingClient)) ??
        (creatingClient
          ? getPublishedApps().find((a) => a.clientId === creatingClient)?.launchUrl
          : undefined)
      const viewerBase = resolveShlViewerBase(launchUrl, getRuntimeBrandConfig().portalUrl)
      const viewerUrl = `${viewerBase.replace(/\/$/, '')}/#${shlinkURI}`

      // Shorten the viewer URL for QR codes / messaging (opt-in, best-effort)
      const shortUrl = body.shortenUrl
        ? await shortenUrl(viewerUrl, {
            expiresAt: new Date(expiresAt).toISOString(),
            ...(body.maxUses && { maxUses: body.maxUses }),
          })
        : null

      logger.auth.info('SHL created', {
        shlId,
        patientId,
        expiresInMinutes,
        hasPasscode: !!passcodeHash,
        verifiedOnly: body.verifiedOnly ?? false,
      })

      return {
        shlinkPayload,
        viewerUrl,
        ...(shortUrl && { shortUrl }),
        expiresAt: new Date(expiresAt).toISOString(),
      }
    } catch (error) {
      logger.auth.error('SHL creation failed', { error })
      set.status = 500
      return { error: error instanceof Error ? error.message : 'SHL creation failed' }
    }
  }, {
    body: CreateShlBody,
    response: { 200: ShlResponse, 401: ErrorResponse, 500: ErrorResponse },
    detail: {
      summary: 'Create SMART Health Link',
      description: 'Create a spec-compliant SHL for QR-based patient data sharing. Uses JWE (A256GCM) encryption via kill-the-clipboard.',
      tags: ['shl'],
      security: [{ BearerAuth: [] }],
    },
  })

  /**
   * Attestation endpoint (recipient POST).
   *
   * The recipient signs before they may write anything. Two shapes, per whether
   * the patient named them when they minted the link:
   *
   *   - named     — the name is already on the session; signing says "that is me"
   *   - not named — the recipient supplies their own name, and signs it
   *
   * Either way the signature is what a later Provenance is attributed to, which
   * is why a write is refused until one exists: an upload that happened first
   * could never be attributed afterwards.
   *
   * This is NOT identity verification and must not be presented as such. An SHL
   * is a bearer link, so whoever holds it can sign as anyone; what the signature
   * establishes is that a deliberate, attributable act took place. Nothing
   * written under it is verified — see the data-verification vocabulary.
   */
  .post('/attest', async ({ body, headers, set }) => {
    const auth = await authorizeShlBearer(headers, set, { writes: true })
    if ('error' in auth) return auth
    const { shlId, session } = auth

    if (!session.writeScope?.dicom) {
      set.status = 403
      return { error: 'This share is read-only — there is nothing to attest to' }
    }

    const signature = body.signature.trim()
    if (!signature.startsWith('data:image/')) {
      set.status = 400
      return { error: 'signature must be a data URL of the drawn mark, e.g. data:image/png;base64,…' }
    }

    // A patient-supplied name wins: the recipient is confirming it is them, not
    // choosing what to be called. Only an unnamed share reads a name from the body.
    const patientName = session.recipientName?.trim()
    const ownName = body.name?.trim()
    const name = patientName || ownName
    if (!name) {
      set.status = 400
      return { error: 'This share names no recipient — send your own name with the signature' }
    }
    const attestation = {
      name,
      nameSource: patientName ? ('patient' as const) : ('recipient' as const),
      signature,
      signedAt: Date.now(),
    }

    if (!(await shlSessionStore.recordAttestation(shlId, attestation))) {
      set.status = 409
      return { error: 'This share has already been signed' }
    }

    logger.auth.info('SHL attestation recorded', {
      shlId,
      nameSource: attestation.nameSource,
      patientId: session.patientId,
    })

    return {
      name: attestation.name,
      nameSource: attestation.nameSource,
      signedAt: new Date(attestation.signedAt).toISOString(),
    }
  }, {
    body: t.Object({
      name: t.Optional(t.String({ description: 'The name the signer goes by. Required only when the patient named no recipient; ignored otherwise.', maxLength: 200 })),
      signature: t.String({ description: 'The drawn signature as a data URL, e.g. data:image/png;base64,…', maxLength: 2_000_000 }),
    }),
    response: {
      200: t.Object({
        name: t.String(),
        nameSource: t.Union([t.Literal('patient'), t.Literal('recipient')]),
        signedAt: t.String(),
      }),
      400: ErrorResponse,
      401: ErrorResponse,
      403: ErrorResponse,
      409: ErrorResponse,
      410: ErrorResponse,
    },
    detail: {
      summary: 'Sign before writing through a share link',
      description: 'Records the name and drawn signature of the recipient on the share session. Required once before any write is accepted. Establishes attribution, NOT identity — a shared link is a bearer credential.',
      tags: ['shl'],
      security: [{ BearerAuth: [] }],
    },
  })

  /**
   * SHL Manifest endpoint (recipient POST).
   * Returns spec-compliant manifest with JWE-encrypted smart-api-access file.
   * kill-the-clipboard builds URLs as {baseManifestURL}{key}/{id}
   */
  .post('/:key/:id', async ({ params, body, set, request, server }) => {
    const entry = await shlSessionStore.get(params.id)
    if (!entry) {
      set.status = 404
      return { error: 'SHL not found or expired' }
    }

    // Check expiry. SHL spec: a no-longer-active link SHALL return 404.
    if (Date.now() > entry.expiresAt) {
      await shlSessionStore.delete(params.id)
      set.status = 404
      return { error: 'SHL not found or expired' }
    }

    // Revoked in the consent portal? Deny (spec: 404 for a no-longer-active link).
    if (await isShareConsentRevoked(params.id, entry.fhirServerUrl)) {
      await shlSessionStore.delete(params.id) // purge the now-inert session
      set.status = 404
      return { error: 'SHL not found or expired' }
    }

    // Passcode validation (per SHL spec)
    if (entry.passcodeHash) {
      if (!body.passcode) {
        set.status = 401
        return JSON.stringify({ remainingAttempts: 3 })
      }
      const hash = sha256(body.passcode)
      if (hash !== entry.passcodeHash) {
        set.status = 401
        return JSON.stringify({ remainingAttempts: 2 })
      }
    }

    // Count this open, track the (fingerprinted) recipient/device for the
    // distinct-devices metric, and record a FHIR access AuditEvent (best-effort).
    await shlSessionStore.incrementAccessCount(params.id)
    const ipAddress = clientIp(request, { server })
    await recordShlOpen(params.id, entry, { recipient: body.recipient, ipAddress, userAgent: request.headers.get('user-agent') || undefined })

    logger.auth.info('SHL manifest accessed', {
      shlId: params.id,
      accessCount: entry.accessCount + 1,
      recipient: body.recipient,
    })

    // Re-derive the access document from the session so it describes the share as
    // it is now. Falls back to the stored blob only if encryption fails, since a
    // stale claim still beats handing the recipient an unopenable link.
    let embedded = entry.jwe
    try {
      embedded = await encryptSHLFile({
        content: buildSmartApiAccess(entry),
        key: entry.shl.key,
        contentType: SMART_API_ACCESS,
      })
    } catch (error) {
      logger.auth.error('Could not rebuild the SHL access document — serving the one stored at mint', {
        shlId: params.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Return spec-compliant SHL manifest
    // The JWE compact string goes directly in `embedded` (not wrapped in custom JSON)
    return {
      files: [{
        contentType: SMART_API_ACCESS,
        embedded,
      }],
    }
  }, {
    params: t.Object({ key: t.String(), id: t.String() }),
    body: ManifestRequest,
    detail: {
      summary: 'Fetch SHL Manifest',
      description: 'Spec-compliant SHL manifest endpoint. Returns JWE-encrypted smart-api-access token.',
      tags: ['shl'],
    },
  })

  /**
   * FHIR Proxy for SHL viewers.
   * Validates the opaque session token, then proxies to the real FHIR server
   * using a Keycloak service account. No user tokens ever reach the viewer.
   *
   * Two routes: `/fhir` (for _getpages pagination) and `/fhir/*` (for resource paths).
   */
  .all('/fhir', shlFhirProxyHandler, {
    detail: {
      summary: 'SHL FHIR Proxy (base)',
      description: 'Handles _getpages pagination requests via the SHL FHIR proxy.',
      tags: ['shl'],
      hide: true,
    },
  })
  .all('/fhir/*', shlFhirProxyHandler, {
    detail: {
      summary: 'SHL FHIR Proxy',
      description: 'Proxies FHIR requests from SHL viewers using opaque session tokens. No real tokens leave the server.',
      tags: ['shl'],
      hide: true,
    },
  })

  // ── SHL DICOMweb proxy ──────────────────────────────────────────────────

  .all('/dicomweb/*', shlDicomwebProxyHandler, {
    detail: {
      summary: 'SHL DICOMweb Proxy',
      description: 'Proxies DICOMweb requests from SHL viewers using opaque session tokens.',
      tags: ['shl'],
      hide: true,
    },
  })
