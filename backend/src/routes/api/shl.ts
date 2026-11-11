// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// SHL manifests carry an opaque session token for our /api/shl/fhir proxy; no real tokens leave the server.
// @see https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html

import { Elysia, t } from 'elysia'
import { SHL, encryptSHLFile, type SHLFileContentType } from 'kill-the-clipboard'
import { config } from '@/config'
import { authenticatePatientCaller } from './patient-caller'
import { authorizeShlBearer, sessionSelectiveScope, shlDicomwebProxyHandler, shlFhirProxyHandler } from './shl-proxy'
import { logger } from '@/lib/logger'
import { clientIp } from '@/lib/client-ip'
import { getDefaultFhirServer } from '@/lib/shl/service-account'
import { emitShareConsent, shareConsentStatus } from '@/lib/consent/shl-consent'
import { recordShlOpen } from '@/lib/consent/shl-audit'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { shortenUrl } from '@/lib/url-shortener'
import { getPublishedApps } from '@/lib/app-store-config'
import { resolveClientLaunchUrl, resolveShlViewerBase } from '@/lib/client-launch-url'
import { shlSessionStore, type ShareScope, type ShlAttestation, type ShlWriteScope } from '@/lib/shl/session-store'
import { isCompleteShare, shareQueryHints } from '@/lib/shl/scope'
import { patientStudyUids } from '@/lib/shl/shared-studies'
import * as crypto from 'crypto'
import { sha256 } from '@/lib/hash'
import { tokenClientId } from '@/lib/jwt-claims'

// kill-the-clipboard does not list smart-api-access yet; the JWE is identical apart from the cty header.
const SMART_API_ACCESS = 'application/smart-api-access' as SHLFileContentType

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

/** The smart-api-access document (SHL spec §3.2), re-derived on every manifest fetch so it describes the share as it is now. */
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
    aud: `${config.baseUrl}/api/shl/fhir`,
    query: shareQueryHints({ studyInstanceUID: session.studyInstanceUID }),
    complete: isCompleteShare({
      selectiveScope,
      studyInstanceUID: session.studyInstanceUID,
    }),
    // `scope` stays patient/*.read: DICOM upload is not a FHIR operation, so it gets its own field.
    upload: session.writeScope?.dicom ? { dicom: true } : undefined,
    recipientName: session.recipientName,
    attested: session.attestation ? true : undefined,
  })
}

export const shlRoutes = new Elysia({ prefix: '/shl', tags: ['shl'] })

  .post('/', async ({ body, headers, set }) => {
    try {
      const caller = await authenticatePatientCaller(headers, set, 'SHL mint')
      if ('error' in caller) return caller
      const { payload: tokenPayload, patientId } = caller

      const expiresInMinutes = Math.max(1, Math.min(body.expiresInMinutes ?? 60, 4320))
      const ttlSeconds = expiresInMinutes * 60
      const expiresAt = Date.now() + ttlSeconds * 1000

      const fhirServer = await getDefaultFhirServer()

      const sessionToken = crypto.randomBytes(32).toString('base64url')

      const fhirServerUrl = fhirServer.url

      if (body.studyInstanceUID) {
        const owned = await patientStudyUids({ patientId, fhirServerUrl, studyInstanceUID: body.studyInstanceUID })
        if (owned === null) {
          set.status = 503
          return { error: 'Whether this study is in the record could not be checked right now' }
        }
        if (owned.length === 0) {
          set.status = 403
          return { error: 'Only a study in the shared patient\'s record can be shared' }
        }
      }

      // An all-empty scope stays undefined so the proxy takes the "share everything" path.
      const excludedTypes = body.shareScope?.excludedTypes ?? []
      const excludedIds = body.shareScope?.excludedIds ?? []
      const excludedObservationCategories = body.shareScope?.excludedObservationCategories ?? []
      const shareScope: ShareScope | undefined =
        excludedTypes.length + excludedIds.length + excludedObservationCategories.length > 0
          ? { excludedTypes, excludedIds, excludedObservationCategories }
          : undefined

      const smartApiAccess = buildSmartApiAccess({
        sessionToken,
        patientId,
        expiresAt,
        shareScope,
        studyInstanceUID: body.studyInstanceUID,
      })

      const shlId = crypto.randomUUID()
      const shl = SHL.generate({
        id: shlId,
        baseManifestURL: `${config.baseUrl}/api/shl/`,
        manifestPath: shlId,
        expirationDate: new Date(expiresAt),
        flag: body.passcode ? 'P' : undefined,
        label: body.label,
      })

      const jwe = await encryptSHLFile({
        content: smartApiAccess,
        key: shl.key,
        contentType: SMART_API_ACCESS,
      })

      const passcodeHash = body.passcode
        ? sha256(body.passcode)
        : undefined

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
        // `{}` and `{ dicom: false }` mean read-only; storing them would make the share look write-enabled.
        writeScope: body.writeScope?.dicom ? { dicom: true } : undefined,
        recipientName: body.recipientName?.trim() || undefined,
        accessCount: 0,
        passcodeHash,
      }
      await shlSessionStore.set(shlId, session)

      await emitShareConsent(shlId, session)

      // The recipient opens in the app that minted the share: client launch_url, then app-store entry, then portal.
      const shlinkURI = shl.toURI()
      const shlinkPayload = shlinkURI.replace('shlink:/', '')
      const creatingClient = tokenClientId(tokenPayload) ?? ''
      const launchUrl =
        (await resolveClientLaunchUrl(creatingClient)) ??
        (creatingClient
          ? getPublishedApps().find((a) => a.clientId === creatingClient)?.launchUrl
          : undefined)
      const viewerBase = resolveShlViewerBase(launchUrl, getRuntimeBrandConfig().portalUrl)
      const viewerUrl = `${viewerBase.replace(/\/$/, '')}/#${shlinkURI}`

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
    response: { 200: ShlResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse },
    detail: {
      summary: 'Create SMART Health Link',
      description: 'Create a spec-compliant SHL for QR-based patient data sharing. Uses JWE (A256GCM) encryption via kill-the-clipboard.',
      tags: ['shl'],
      security: [{ BearerAuth: [] }],
    },
  })

  // Writes are refused until the recipient signs, so every Provenance has a signer.
  // This is attribution, not identity verification: an SHL is a bearer link.
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

    // A patient-supplied name wins; only an unnamed share reads a name from the body.
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

  // kill-the-clipboard builds manifest URLs as {baseManifestURL}{key}/{id}
  .post('/:key/:id', async ({ params, body, set, request, server }) => {
    const entry = await shlSessionStore.get(params.id)
    if (!entry) {
      set.status = 404
      return { error: 'SHL not found or expired' }
    }

    // SHL spec: a no-longer-active link SHALL return 404.
    if (Date.now() > entry.expiresAt) {
      await shlSessionStore.delete(params.id)
      set.status = 404
      return { error: 'SHL not found or expired' }
    }

    const consentStatus = await shareConsentStatus(params.id, entry.fhirServerUrl)
    if (consentStatus === 'revoked') {
      await shlSessionStore.delete(params.id)
      set.status = 404
      return { error: 'SHL not found or expired' }
    }
    if (consentStatus === 'unverifiable') {
      set.status = 503
      set.headers['retry-after'] = '30'
      return { error: 'Whether this link is still shared could not be checked right now' }
    }

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

    await shlSessionStore.incrementAccessCount(params.id)
    const ipAddress = clientIp(request, { server })
    await recordShlOpen(params.id, entry, { recipient: body.recipient, ipAddress, userAgent: request.headers.get('user-agent') || undefined })

    logger.auth.info('SHL manifest accessed', {
      shlId: params.id,
      accessCount: entry.accessCount + 1,
      recipient: body.recipient,
    })

    // The stored blob is only a fallback: a stale claim beats an unopenable link.
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
  .all('/dicomweb/*', shlDicomwebProxyHandler, {
    detail: {
      summary: 'SHL DICOMweb Proxy',
      description: 'Proxies DICOMweb requests from SHL viewers using opaque session tokens.',
      tags: ['shl'],
      hide: true,
    },
  })
