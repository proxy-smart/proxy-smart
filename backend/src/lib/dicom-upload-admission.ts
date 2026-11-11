// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config, type UploadAdmissionConfig } from '@/config'
import { logger } from '@/lib/logger'
import { actorOf } from '@/lib/fhir-authorship'
import { dicomStudyUidsOf, isSystemGrant, studyUidOf } from '@/lib/dicomweb-access'
import { readSignedCreations, signedCreations, type AuthoredLookupContext } from '@/lib/fhir-author-access'
import { tokenClientId } from '@/lib/jwt-claims'
import { isRecord, optionalString } from '@/lib/type-guards'
import type { UpstreamFetch } from '@/lib/upstream-fetch'
import type { DicomServerConfigType, DicomStorageRefusalType, DicomStorageUsageType, DicomUploadRefusalResponseType } from '@/schemas'

/** What the proxy asks the admission service about one upload. */
export interface AdmissionQuestion {
  subject: string | null
  fhirUser: string
  clientId: string | null
  usedBytes: number
  /** Null for a chunked upload, whose size is known only as it streams. */
  incomingBytes: number | null
  studyInstanceUid: string | null
  dicomServerId: string | null
  /** The caller's token claims named in the config; absent when none are configured. */
  claims?: Record<string, unknown>
}

export interface AdmissionAnswer {
  allow: boolean
  limitBytes?: number
  reason?: string
}

export interface UploadAdmissionDeps {
  /** Study Instance UIDs of the ImagingStudies the proxy signed `actor` as having added. */
  studiesUploadedBy: (actor: string, authHeader: string) => Promise<string[]>
  /** The PACS footprint of those studies, measured now rather than from a cache. */
  measureFresh: (studyUids: string[], server: DicomServerConfigType | null) => Promise<DicomStorageUsageType>
  ask: (service: UploadAdmissionConfig, question: AdmissionQuestion) => Promise<AdmissionAnswer>
}

export interface UploadRequest {
  caller: Record<string, unknown>
  authHeader: string
  subPath: string
  body: ReadableStream<Uint8Array> | null
  contentLength: string | null
  server: DicomServerConfigType | null
  /** Stops the upstream request once a streamed body passes the limit. */
  abort: () => void
}

export type UploadAdmission =
  | { admitted: false; status: 413; refusal: DicomStorageRefusalType }
  | { admitted: false; status: 503 }
  | { admitted: true; body: ReadableStream<Uint8Array> | null; overrun: () => DicomStorageRefusalType | null }

/** The studies of the ImagingStudies the proxy signed `actor` as having added, read as they were created. */
export async function uploadedStudyUids(ctx: AuthoredLookupContext, actor: string): Promise<string[]> {
  const { signed, truncated } = await signedCreations(ctx, actor)
  if (truncated) logger.fhir.warn('Upload usage counts only the first page limit of added records', { actor })
  const studies = signed.filter(({ creation }) => creation.startsWith('ImagingStudy/'))
  const records = await readSignedCreations(ctx, studies)
  return records.flatMap(({ resource }) => dicomStudyUidsOf(resource))
}

export function parseAdmissionAnswer(value: unknown): AdmissionAnswer | null {
  if (!isRecord(value) || typeof value.allow !== 'boolean') return null
  const limit = value.limitBytes
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) return null
  return { allow: value.allow, ...(limit !== undefined && { limitBytes: limit }), ...(optionalString(value.reason) && { reason: optionalString(value.reason) }) }
}

/** POSTs the question to the admission service; throws on a timeout, a non-2xx answer or an answer it cannot read. */
export function askAdmissionService(fetcher: UpstreamFetch) {
  return async (service: UploadAdmissionConfig, question: AdmissionQuestion): Promise<AdmissionAnswer> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (service.secret) headers.authorization = `Bearer ${service.secret}`
    const response = await fetcher(service.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(question),
      redirect: 'error',
      signal: AbortSignal.timeout(service.timeoutMs),
    })
    if (!response.ok) throw new Error(`The admission service answered HTTP ${response.status}`)
    const answer = parseAdmissionAnswer(await response.json())
    if (!answer) throw new Error('The admission service answered without a boolean allow')
    return answer
  }
}

/** Passes `body` through until `usedBytes` plus what has streamed passes `limitBytes`, then fails it. */
export function meteredUploadBody(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
  usedBytes: number,
  onOverrun: (refusal: DicomStorageRefusalType) => void,
): ReadableStream<Uint8Array> {
  let streamed = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamed += chunk.byteLength
      if (usedBytes + streamed <= limitBytes) {
        controller.enqueue(chunk)
        return
      }
      onOverrun({ usedBytes, limitBytes, incomingBytes: streamed })
      controller.error(new Error('The upload passed the storage limit'))
    },
  }))
}

/** The configured claims the verified token carries, or undefined when none are configured. */
export function forwardedClaims(caller: Record<string, unknown>, names: readonly string[]): Record<string, unknown> | undefined {
  if (names.length === 0) return undefined
  return Object.fromEntries(names.flatMap((name) => (caller[name] === undefined ? [] : [[name, caller[name]]])))
}

function unmetered(body: ReadableStream<Uint8Array> | null): UploadAdmission {
  return { admitted: true, body, overrun: () => null }
}

function declaredBytes(contentLength: string | null): number | null {
  const value = contentLength?.trim()
  return value && /^\d+$/.test(value) ? Number(value) : null
}

/** Bytes the caller's uploads occupy; null when the PACS cannot tell, so no limit applies. */
async function usedBytes(actor: string, upload: UploadRequest, deps: UploadAdmissionDeps): Promise<number | null> {
  try {
    const studies = await deps.studiesUploadedBy(actor, upload.authHeader)
    const usage = await deps.measureFresh(studies, upload.server)
    if (usage.bytes === null) {
      logger.fhir.warn('Upload admission skipped: the PACS cannot report study sizes', { actor, serverId: upload.server?.id, studies: usage.studies })
    }
    return usage.bytes
  } catch (error) {
    logger.fhir.warn('Upload admission skipped: storage use could not be measured', { actor, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function answerFor(service: UploadAdmissionConfig, question: AdmissionQuestion, deps: UploadAdmissionDeps): Promise<AdmissionAnswer | null> {
  try {
    return await deps.ask(service, question)
  } catch (error) {
    logger.fhir.warn('The upload admission service could not be asked', {
      fhirUser: question.fhirUser,
      onError: service.onError,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Admit a STOW-RS upload as the configured admission service decides. Without a service, for system
 * grants, and wherever usage cannot be measured, uploads are unlimited. A declared size is decided up
 * front; a chunked one is metered against the limit the service names.
 */
export async function admitDicomUpload(upload: UploadRequest, deps: UploadAdmissionDeps): Promise<UploadAdmission> {
  const service = config.dicomweb.uploadAdmission
  if (!service || isSystemGrant(upload.caller)) return unmetered(upload.body)

  const actor = actorOf(upload.caller)
  if (!actor) {
    logger.fhir.warn('Upload admission skipped: the caller has no fhirUser to count uploads by')
    return unmetered(upload.body)
  }
  const used = await usedBytes(actor, upload, deps)
  if (used === null) return unmetered(upload.body)

  const incomingBytes = declaredBytes(upload.contentLength)
  const claims = forwardedClaims(upload.caller, service.claims)
  const answer = await answerFor(service, {
    subject: optionalString(upload.caller.sub) ?? null,
    fhirUser: actor,
    clientId: tokenClientId(upload.caller) ?? null,
    usedBytes: used,
    incomingBytes,
    studyInstanceUid: studyUidOf(upload.subPath),
    dicomServerId: upload.server?.id ?? null,
    ...(claims && { claims }),
  }, deps)
  if (!answer) return service.onError === 'deny' ? { admitted: false, status: 503 } : unmetered(upload.body)

  if (!answer.allow) {
    const refusal = { usedBytes: used, limitBytes: answer.limitBytes ?? null, incomingBytes, ...(answer.reason && { reason: answer.reason }) }
    logger.fhir.info('DICOM upload refused by the admission service', { actor, ...refusal })
    return { admitted: false, status: 413, refusal }
  }
  if (answer.limitBytes === undefined || !upload.body) return unmetered(upload.body)

  let overrun: DicomStorageRefusalType | null = null
  const body = meteredUploadBody(upload.body, answer.limitBytes, used, (exceeded) => {
    overrun = exceeded
    logger.fhir.info('DICOM upload stopped at the storage limit', { actor, ...exceeded })
    upload.abort()
  })
  return { admitted: true, body, overrun: () => overrun }
}

export function uploadRefusalBody(refusal: DicomStorageRefusalType): DicomUploadRefusalResponseType {
  return {
    error: 'upload_limit_exceeded',
    message: refusal.reason ?? 'This upload needs more storage than is left.',
    ...refusal,
  }
}

export const UPLOAD_ADMISSION_UNAVAILABLE = {
  error: 'upload_admission_unavailable',
  details: { message: 'Whether this upload fits could not be checked right now. Please try again.' },
}
