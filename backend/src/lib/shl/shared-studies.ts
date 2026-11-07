// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { studyUidsOf } from '../dicomweb-access'
import { logger } from '../logger'
import { upstreamFetch, type UpstreamFetch } from '../upstream-fetch'
import { screenSharedPatientAnswer } from './patient-scope'
import { applySelectiveFilter, type SelectiveScope } from './scope'
import { getServiceAccountToken } from './service-account'

export interface ShareImaging {
  patientId: string
  fhirServerUrl: string
  studyInstanceUID?: string
  selective?: SelectiveScope
}

export interface SharedStudiesDeps {
  fetch: UpstreamFetch
  token: () => Promise<string>
}

const STUDY_LOOKUP_LIMIT = 1000
const CACHE_TTL_MS = 60_000
const MAX_CACHED = 5_000

const defaultDeps: SharedStudiesDeps = { fetch: upstreamFetch, token: () => getServiceAccountToken() }
const cache = new Map<string, { uids: string[]; expiresAt: number }>()

export function clearSharedStudiesCache(): void {
  cache.clear()
}

/** The patient's DICOM studies as their ImagingStudies name them, kept to what the share covers; null when the lookup failed. */
export async function patientStudyUids(share: ShareImaging, deps: SharedStudiesDeps = defaultDeps): Promise<string[] | null> {
  try {
    const token = await deps.token()
    const query = new URLSearchParams({ patient: `Patient/${share.patientId}`, _count: String(STUDY_LOOKUP_LIMIT) })
    const resp = await deps.fetch(`${share.fhirServerUrl}/ImagingStudy?${query}`, {
      headers: { accept: 'application/fhir+json', authorization: `Bearer ${token}` },
    })
    if (!resp.ok) {
      logger.auth.warn('Shared patient studies could not be listed', { status: resp.status })
      return null
    }
    const shared = { patientId: share.patientId, serverUrl: share.fhirServerUrl }
    const screened = screenSharedPatientAnswer(await resp.json(), shared)
    const kept = share.selective ? applySelectiveFilter(screened.body, share.selective).body : screened.body
    const uids = studyUidsOf(kept)
    return share.studyInstanceUID ? uids.filter((uid) => uid === share.studyInstanceUID) : uids
  } catch (error) {
    logger.auth.warn('Shared patient studies could not be listed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** {@link patientStudyUids} for one share link, remembered briefly since a viewer fetches many frames per study. */
export async function sharedStudyUids(shlId: string, share: ShareImaging, deps: SharedStudiesDeps = defaultDeps): Promise<string[] | null> {
  const cached = cache.get(shlId)
  if (cached && cached.expiresAt > Date.now()) return cached.uids
  const uids = await patientStudyUids(share, deps)
  if (uids === null) return null
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(shlId, { uids, expiresAt: Date.now() + CACHE_TTL_MS })
  return uids
}
