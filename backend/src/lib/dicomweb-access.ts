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
import { refusal, upstreamUnverifiable, type AccessDecision } from './access-decision'
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
  /** Whether this patient's record refuses new data, its holding consent withdrawn; null when unknown. */
  refusesNewData: (patientId: string, authHeader: string) => Promise<boolean | null>
}

export type DicomAccessDecision = AccessDecision<{ rewrittenQuery?: string; emptyResult?: true }>

const STUDY_PATH = /^\/studies\/([0-9.]+)(?:\/|$)/
const DECISION_TTL_MS = 5 * 60 * 1000
/** Short, because a study uploaded a moment ago has no ImagingStudy yet and must not stay refused. */
const NOT_FOUND_TTL_MS = 30 * 1000
const MAX_CACHED_DECISIONS = 20_000
const STUDY_SEARCH_LIMIT = 200
/** FHIR answers that refuse the caller on the merits; any other non-200 means the lookup itself failed. */
const REFUSING_STATUSES = new Set([401, 403])

/** `unverifiable`: the lookup failed, so the answer is neither a grant nor a refusal, and is never cached. */
type StudyAccess = 'readable' | 'unreadable' | 'unverifiable'

const decisions = new Map<string, { access: StudyAccess; expiresAt: number }>()
const inflight = new Map<string, Promise<StudyAccess>>()

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

function expiryFor(caller: Record<string, unknown>, access: StudyAccess): number {
  const now = Date.now()
  const ttl = access === 'readable' ? DECISION_TTL_MS : NOT_FOUND_TTL_MS
  const exp = typeof caller.exp === 'number' ? caller.exp * 1000 : now + ttl
  return Math.min(exp, now + ttl)
}

function accessOf(result: ImagingStudySearch, studyUid: string): StudyAccess {
  if (result.status === 200) return result.studyUids.includes(studyUid) ? 'readable' : 'unreadable'
  return REFUSING_STATUSES.has(result.status) ? 'unreadable' : 'unverifiable'
}

async function studyAccess(
  caller: Record<string, unknown>,
  authHeader: string,
  studyUid: string,
  deps: DicomAccessDeps,
): Promise<StudyAccess> {
  const key = `${tokenKey(caller, authHeader)}|${studyUid}`
  const cached = decisions.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.access

  const pending = inflight.get(key)
  if (pending) return pending

  const lookup = deps
    .searchImagingStudies(authHeader, `identifier=urn:oid:${studyUid}&_count=1`)
    .then((result) => accessOf(result, studyUid))
    .catch((): StudyAccess => 'unverifiable')
    .then((access) => {
      if (access === 'unverifiable') return access
      if (decisions.size >= MAX_CACHED_DECISIONS) decisions.clear()
      decisions.set(key, { access, expiresAt: expiryFor(caller, access) })
      return access
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, lookup)
  return lookup
}

function refuse(mode: DicomAccessMode, reason: string, detail: Record<string, unknown>): DicomAccessDecision {
  logger.fhir.warn('DICOMweb access refused', { reason, ...detail, wouldDeny: mode !== 'enforce' })
  if (mode !== 'enforce') return { allowed: true }
  return refusal('You do not have access to this imaging study.')
}

function unverifiable(mode: DicomAccessMode, detail: Record<string, unknown>): DicomAccessDecision {
  logger.fhir.warn('DICOMweb access unverifiable: the ImagingStudy lookup failed', { ...detail, wouldDeny: mode !== 'enforce' })
  if (mode !== 'enforce') return { allowed: true }
  return upstreamUnverifiable('Access to this imaging study could not be checked right now. Please try again.')
}

/** A study-level decision: served, refused on the merits, or unverifiable because the lookup failed. */
async function decideStudy(
  caller: Record<string, unknown>,
  authHeader: string,
  studyUid: string,
  mode: DicomAccessMode,
  reason: string,
  deps: DicomAccessDeps,
): Promise<DicomAccessDecision> {
  const access = await studyAccess(caller, authHeader, studyUid, deps)
  if (access === 'readable') return { allowed: true }
  if (access === 'unverifiable') return unverifiable(mode, { studyUid })
  return refuse(mode, reason, { studyUid })
}

/** The studies the caller can read as ImagingStudies, as the FHIR proxy answers for them. */
export function readableStudies(authHeader: string, deps: DicomAccessDeps): Promise<ImagingStudySearch> {
  return deps
    .searchImagingStudies(authHeader, `_count=${STUDY_SEARCH_LIMIT}&_elements=identifier`)
    .catch((): ImagingStudySearch => ({ status: 502, studyUids: [] }))
}

/** Narrow a QIDO study search to the studies the caller can read as ImagingStudies. */
async function narrowStudySearch(
  authHeader: string,
  query: string,
  mode: DicomAccessMode,
  deps: DicomAccessDeps,
): Promise<DicomAccessDecision> {
  const result = await readableStudies(authHeader, deps)
  if (REFUSING_STATUSES.has(result.status)) return refuse(mode, 'study search refused by FHIR access control', { status: result.status })
  if (result.status !== 200) return unverifiable(mode, { status: result.status })

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
  if (studyUid) return decideStudy(caller, authHeader, studyUid, mode, 'study not readable as an ImagingStudy', deps)

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
  if (studyUid) {
    const decision = await decideStudy(caller, authHeader, studyUid, mode, 'store into a study that is not readable', deps)
    if (!decision.allowed) return decision
  }

  const identity = await deps.callerIdentity(caller, authHeader)
  if (!identity.patientId && !identity.practitioner) {
    return refuse(mode, 'store from an account with no record of its own', {})
  }
  if (identity.patientId) {
    const closed = await deps.refusesNewData(identity.patientId, authHeader)
    if (closed === null) return unverifiable(mode, { patientId: identity.patientId })
    if (closed) return refusal('You withdrew the consent your record is held on, so nothing can be added to it.', 'record_closed')
  }
  return { allowed: true }
}
