// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Authorization for the DICOMweb proxy. A study is reachable exactly when the caller can read its
 * ImagingStudy through the FHIR proxy, so the scope, compartment, consent and tenant decisions
 * that govern the record also govern its images. Decisions are cached per token and study, since
 * one viewer session fetches hundreds of frames of the same study.
 */

import { createHash } from 'node:crypto'
import { parseTokenScopes } from '@proxy-smart/auth'
import { logger } from './logger'
import type { CallerIdentity } from './caller-identity'

export type DicomAccessMode = 'enforce' | 'audit-only' | 'disabled'

export interface ImagingStudySearch {
  status: number
  studyUids: string[]
}

export interface DicomAccessDeps {
  mode: () => DicomAccessMode
  /** ImagingStudy search through the FHIR proxy, as the caller; `query` is the FHIR query string. */
  searchImagingStudies: (authHeader: string, query: string) => Promise<ImagingStudySearch>
  callerIdentity: (caller: Record<string, unknown>, authHeader: string) => Promise<CallerIdentity>
}

export type DicomAccessDecision =
  | { allowed: true; rewrittenQuery?: string; emptyResult?: true }
  | { allowed: false; status: number; error: string; message: string }

const STUDY_PATH = /^\/studies\/([0-9.]+)(?:\/|$)/
const DECISION_TTL_MS = 5 * 60 * 1000
const MAX_CACHED_DECISIONS = 20_000
const STUDY_SEARCH_LIMIT = 200

const decisions = new Map<string, { allowed: boolean; expiresAt: number }>()
const inflight = new Map<string, Promise<boolean>>()

export function clearDicomAccessCache(): void {
  decisions.clear()
  inflight.clear()
}

/** The study a DICOMweb path is about, or null for a search above study level. */
export function studyUidOf(subPath: string): string | null {
  return STUDY_PATH.exec(subPath)?.[1] ?? null
}

function isSystemGrant(caller: Record<string, unknown>): boolean {
  const scopes = [...parseTokenScopes(caller)]
  return scopes.length > 0 && scopes.every((s) => !s.includes('/') || s.startsWith('system/'))
    && scopes.some((s) => s.startsWith('system/'))
}

function tokenKey(caller: Record<string, unknown>, authHeader: string): string {
  if (typeof caller.jti === 'string' && caller.jti) return caller.jti
  return createHash('sha256').update(authHeader).digest('hex')
}

function expiryFor(caller: Record<string, unknown>): number {
  const now = Date.now()
  const exp = typeof caller.exp === 'number' ? caller.exp * 1000 : now + DECISION_TTL_MS
  return Math.min(exp, now + DECISION_TTL_MS)
}

async function canReadStudy(
  caller: Record<string, unknown>,
  authHeader: string,
  studyUid: string,
  deps: DicomAccessDeps,
): Promise<boolean> {
  const key = `${tokenKey(caller, authHeader)}|${studyUid}`
  const cached = decisions.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.allowed

  const pending = inflight.get(key)
  if (pending) return pending

  const lookup = deps
    .searchImagingStudies(authHeader, `identifier=urn:oid:${studyUid}&_count=1`)
    .then((result) => result.status === 200 && result.studyUids.includes(studyUid))
    .catch(() => false)
    .then((allowed) => {
      if (decisions.size >= MAX_CACHED_DECISIONS) decisions.clear()
      decisions.set(key, { allowed, expiresAt: expiryFor(caller) })
      return allowed
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, lookup)
  return lookup
}

function refuse(mode: DicomAccessMode, reason: string, detail: Record<string, unknown>): DicomAccessDecision {
  logger.fhir.warn('DICOMweb access refused', { reason, ...detail, wouldDeny: mode !== 'enforce' })
  if (mode !== 'enforce') return { allowed: true }
  return {
    allowed: false,
    status: 403,
    error: 'access_denied',
    message: 'You do not have access to this imaging study.',
  }
}

/** Narrow a QIDO study search to the studies the caller can read as ImagingStudies. */
async function narrowStudySearch(
  authHeader: string,
  query: string,
  mode: DicomAccessMode,
  deps: DicomAccessDeps,
): Promise<DicomAccessDecision> {
  const result = await deps.searchImagingStudies(authHeader, `_count=${STUDY_SEARCH_LIMIT}&_elements=identifier`)
  if (result.status !== 200) return refuse(mode, 'study search refused by FHIR access control', { status: result.status })

  const params = new URLSearchParams(query)
  const requested = params.get('StudyInstanceUID')?.split(',').filter(Boolean)
  const readable = requested ? result.studyUids.filter((uid) => requested.includes(uid)) : result.studyUids
  if (mode !== 'enforce') return { allowed: true }
  if (readable.length === 0) return { allowed: true, emptyResult: true }

  params.set('StudyInstanceUID', readable.join(','))
  return { allowed: true, rewrittenQuery: `?${params.toString()}` }
}

export async function authorizeDicomRead(
  caller: Record<string, unknown>,
  authHeader: string,
  subPath: string,
  query: string,
  deps: DicomAccessDeps,
): Promise<DicomAccessDecision> {
  const mode = deps.mode()
  if (mode === 'disabled' || isSystemGrant(caller)) return { allowed: true }

  const studyUid = studyUidOf(subPath)
  if (studyUid) {
    if (await canReadStudy(caller, authHeader, studyUid, deps)) return { allowed: true }
    return refuse(mode, 'study not readable as an ImagingStudy', { studyUid })
  }

  if (subPath.replace(/\/+$/, '') === '/studies') return narrowStudySearch(authHeader, query, mode, deps)

  return refuse(mode, 'search below study level without a study', { subPath })
}

export async function authorizeDicomStore(
  caller: Record<string, unknown>,
  authHeader: string,
  subPath: string,
  deps: DicomAccessDeps,
): Promise<DicomAccessDecision> {
  const mode = deps.mode()
  if (mode === 'disabled' || isSystemGrant(caller)) return { allowed: true }

  const studyUid = studyUidOf(subPath)
  if (studyUid && !(await canReadStudy(caller, authHeader, studyUid, deps))) {
    return refuse(mode, 'store into a study that is not readable', { studyUid })
  }

  const identity = await deps.callerIdentity(caller, authHeader)
  if (!identity.patientId && !identity.practitioner) {
    return refuse(mode, 'store from an account with no record of its own', {})
  }
  return { allowed: true }
}
