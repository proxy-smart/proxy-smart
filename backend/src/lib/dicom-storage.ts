// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * How much PACS storage a set of studies occupies, and removing a study's images. DICOMweb has
 * neither a size attribute nor a delete, so both go through the PACS's own API. Orthanc is the
 * one supported today; any other PACS reports its studies as unmeasured and cannot remove them.
 */

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { isRecord } from '@/lib/type-guards'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { upstreamAuthHeader } from '@/lib/http-auth'
import { getDefaultDicomServer } from '@/lib/dicom-server-config'
import { upstreamFetch, type UpstreamFetch } from '@/lib/upstream-fetch'
import type { DicomServerConfigType, DicomStorageUsageType } from '@/schemas'

const LOOKUP_CONCURRENCY = 6

const apiRoots = new TtlCache<string | null>({ ttlMs: 10 * 60 * 1000, maxEntries: 100 })
const studySizes = new TtlCache<number>({ ttlMs: 60 * 1000, maxEntries: 20_000 })

export function clearDicomStorageCache(): void {
  apiRoots.clear()
  studySizes.clear()
}

/** Orthanc serves DICOMweb under a root of its REST API, so the REST API is the parent path. */
export function orthancRootOf(dicomwebBase: string): string {
  const url = new URL(dicomwebBase)
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

function pacsFetch(fetcher: UpstreamFetch, server: DicomServerConfigType, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const auth = upstreamAuthHeader(server)
  if (auth) headers.set('authorization', auth)
  const timeoutMs = server.timeoutMs ?? config.dicomweb.timeoutMs
  return fetcher(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
}

async function pacsJson(fetcher: UpstreamFetch, server: DicomServerConfigType, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await pacsFetch(fetcher, server, url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function orthancRoot(fetcher: UpstreamFetch, server: DicomServerConfigType): Promise<string | null> {
  return apiRoots.getOrLoad(server.baseUrl, async () => {
    const candidate = orthancRootOf(server.baseUrl)
    const system = await pacsJson(fetcher, server, `${candidate}/system`).catch(() => null)
    return isRecord(system) && typeof system.ApiVersion === 'number' ? candidate : null
  })
}

function byteCount(value: unknown): number {
  const bytes = typeof value === 'string' ? Number(value) : value
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('PACS reported no study size')
  return bytes
}

/** Orthanc keys a study by patient and Study Instance UID, so one UID can name several of its studies. */
async function orthancStudyIds(fetcher: UpstreamFetch, server: DicomServerConfigType, root: string, studyUid: string): Promise<string[]> {
  const matches = await pacsJson(fetcher, server, `${root}/tools/lookup`, { method: 'POST', body: studyUid })
  if (!Array.isArray(matches)) return []
  return matches.flatMap((m) => (isRecord(m) && m.Type === 'Study' && typeof m.ID === 'string' ? [m.ID] : []))
}

async function orthancStudyBytes(fetcher: UpstreamFetch, server: DicomServerConfigType, root: string, studyUid: string): Promise<number> {
  const [id] = await orthancStudyIds(fetcher, server, root, studyUid)
  if (!id) return 0
  const statistics = await pacsJson(fetcher, server, `${root}/studies/${encodeURIComponent(id)}/statistics`)
  return byteCount(isRecord(statistics) ? statistics.DiskSize : undefined)
}

function studyBytes(fetcher: UpstreamFetch, server: DicomServerConfigType, root: string, studyUid: string): Promise<number | null> {
  return studySizes
    .getOrLoad(`${server.baseUrl}|${studyUid}`, () => orthancStudyBytes(fetcher, server, root, studyUid))
    .catch((err: unknown) => {
      logger.fhir.warn('PACS study size lookup failed', { serverId: server.id, studyUid, error: err instanceof Error ? err.message : String(err) })
      return null
    })
}

async function mapConcurrently<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** The PACS footprint of these studies. A study the PACS could not size counts as unmeasured, never as zero bytes. */
export async function measureStudyStorage(
  studyUids: readonly string[],
  server: DicomServerConfigType | null = getDefaultDicomServer(),
  fetcher: UpstreamFetch = upstreamFetch,
): Promise<DicomStorageUsageType> {
  const unique = [...new Set(studyUids)]
  const root = server ? await orthancRoot(fetcher, server) : null
  if (!server || !root) return { studies: unique.length, bytes: null, unmeasuredStudies: unique.length }

  const measured = await mapConcurrently(unique, LOOKUP_CONCURRENCY, (uid) => studyBytes(fetcher, server, root, uid))
  const known = measured.filter((bytes): bytes is number => bytes !== null)
  const anyMeasured = known.length > 0 || unique.length === 0
  return {
    studies: unique.length,
    bytes: anyMeasured ? known.reduce((sum, bytes) => sum + bytes, 0) : null,
    unmeasuredStudies: unique.length - known.length,
  }
}

export type StudyImageErasure = 'erased' | 'absent' | 'unsupported'

/** Delete every PACS copy of a study's images. `unsupported`: a PACS is configured but offers no way to delete. */
export async function eraseStudyImages(
  studyUid: string,
  server: DicomServerConfigType | null = getDefaultDicomServer(),
  fetcher: UpstreamFetch = upstreamFetch,
): Promise<StudyImageErasure> {
  if (!server) return 'absent'
  const root = await orthancRoot(fetcher, server)
  if (!root) return 'unsupported'
  const ids = await orthancStudyIds(fetcher, server, root, studyUid)
  for (const id of ids) {
    const response = await pacsFetch(fetcher, server, `${root}/studies/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`Deleting study ${studyUid} from the PACS failed (HTTP ${response.status})`)
  }
  studySizes.delete(`${server.baseUrl}|${studyUid}`)
  logger.fhir.info('Deleted study images from the PACS', { serverId: server.id, studyUid, copies: ids.length })
  return ids.length > 0 ? 'erased' : 'absent'
}
