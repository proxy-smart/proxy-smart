// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { actorOf } from '@/lib/fhir-authorship'
import { dicomStudyUidsOf, isSystemGrant } from '@/lib/dicomweb-access'
import { readSignedCreations, signedCreations, type AuthoredLookupContext } from '@/lib/fhir-author-access'
import { meteredUploadBody, refuseStorage, storagePolicyFor } from '@/lib/dicom-upload-quota'
import type { DicomServerConfigType, DicomStorageRefusalType, DicomStorageUsageType, DicomUploadRefusalResponseType } from '@/schemas'

export interface UploadQuotaDeps {
  /** Study Instance UIDs of the ImagingStudies the proxy signed `actor` as having added. */
  studiesUploadedBy: (actor: string, authHeader: string) => Promise<string[]>
  /** The PACS footprint of those studies, measured now rather than from a cache. */
  measureFresh: (studyUids: string[], server: DicomServerConfigType | null) => Promise<DicomStorageUsageType>
}

export interface UploadRequest {
  caller: Record<string, unknown>
  authHeader: string
  body: ReadableStream<Uint8Array> | null
  contentLength: string | null
  server: DicomServerConfigType | null
  /** Stops the upstream request once a streamed body passes the plan. */
  abort: () => void
}

export type UploadAdmission =
  | { admitted: false; refusal: DicomStorageRefusalType }
  | { admitted: true; body: ReadableStream<Uint8Array> | null; overrun: () => DicomStorageRefusalType | null }

/** The studies of the ImagingStudies the proxy signed `actor` as having added, read as they were created. */
export async function uploadedStudyUids(ctx: AuthoredLookupContext, actor: string): Promise<string[]> {
  const { signed, truncated } = await signedCreations(ctx, actor)
  if (truncated) logger.fhir.warn('Upload quota counts only the first page limit of added records', { actor })
  const studies = signed.filter(({ creation }) => creation.startsWith('ImagingStudy/'))
  const records = await readSignedCreations(ctx, studies)
  return records.flatMap(({ resource }) => dicomStudyUidsOf(resource))
}

function unmetered(body: ReadableStream<Uint8Array> | null): UploadAdmission {
  return { admitted: true, body, overrun: () => null }
}

function declaredBytes(contentLength: string | null): number | null {
  const value = contentLength?.trim()
  return value && /^\d+$/.test(value) ? Number(value) : null
}

/** Bytes the caller's uploads occupy; null when the PACS cannot tell, so the upload goes through. */
async function usedBytes(actor: string, upload: UploadRequest, deps: UploadQuotaDeps): Promise<number | null> {
  try {
    const studies = await deps.studiesUploadedBy(actor, upload.authHeader)
    const usage = await deps.measureFresh(studies, upload.server)
    if (usage.bytes === null) {
      logger.fhir.warn('Upload quota not applied: the PACS cannot report study sizes', { actor, serverId: upload.server?.id, studies: usage.studies })
    }
    return usage.bytes
  } catch (error) {
    logger.fhir.warn('Upload quota not applied: storage use could not be measured', { actor, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Admit a STOW-RS upload against the storage the caller's plan includes. A declared size is refused
 * up front; a streamed one is metered and cut off once it passes the plan. Unlimited without a tier
 * claim with a configured limit, for system grants, and wherever usage cannot be measured.
 */
export async function admitDicomUpload(upload: UploadRequest, deps: UploadQuotaDeps): Promise<UploadAdmission> {
  if (isSystemGrant(upload.caller)) return unmetered(upload.body)
  const policy = storagePolicyFor(upload.caller, config.membership.tierClaim, config.dicomweb.storageQuotas.limits)
  if (!policy) return unmetered(upload.body)

  const actor = actorOf(upload.caller)
  if (!actor) {
    logger.fhir.warn('Upload quota not applied: the caller has no fhirUser to count uploads by', { plan: policy.plan })
    return unmetered(upload.body)
  }
  const used = await usedBytes(actor, upload, deps)
  if (used === null) return unmetered(upload.body)

  const declared = declaredBytes(upload.contentLength)
  const refusal = declared === null ? null : refuseStorage(policy, used, declared)
  if (refusal) {
    logger.fhir.info('DICOM upload refused: over the plan\'s storage', { actor, ...refusal })
    return { admitted: false, refusal }
  }
  if (!upload.body) return unmetered(null)

  let overrun: DicomStorageRefusalType | null = null
  const body = meteredUploadBody(upload.body, policy, used, (exceeded) => {
    overrun = exceeded
    logger.fhir.info('DICOM upload stopped: over the plan\'s storage', { actor, ...exceeded })
    upload.abort()
  })
  return { admitted: true, body, overrun: () => overrun }
}

export function uploadRefusalBody(refusal: DicomStorageRefusalType): DicomUploadRefusalResponseType {
  return {
    error: 'storage_quota_exceeded',
    message: 'This upload needs more storage than your plan has left.',
    ...refusal,
  }
}
