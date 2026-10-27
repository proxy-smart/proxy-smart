// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * How much PACS storage a set of studies occupies. DICOMweb has no size attribute, so the
 * figure comes from the PACS's own API. Orthanc is the one supported today; any other PACS
 * reports its studies as unmeasured rather than as empty.
 */

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { isRecord } from '@/lib/type-guards'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { upstreamAuthHeader } from '@/lib/http-auth'
import { getDefaultDicomServer } from '@/lib/dicom-server-config'
import type { UpstreamFetch } from '@/lib/upstream-fetch'
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

async function pacsJson(fetcher: UpstreamFetch, server: DicomServerConfigType, url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const auth = upstreamAuthHeader(server)
  if (auth) headers.set('authorization', auth)
  const timeoutMs = server.timeoutMs ?? config.dicomweb.timeoutMs
  const response = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
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

async function orthancStudyBytes(fetcher: UpstreamFetch, server: DicomServerConfigType, root: string, studyUid: string): Promise<number> {
  const matches = await pacsJson(fetcher, server, `${root}/tools/lookup`, { method: 'POST', body: studyUid })
  const study = Array.isArray(matches) ? matches.find((m) => isRecord(m) && m.Type === 'Study') : undefined
  if (!isRecord(study) || typeof study.ID !== 'string') return 0
  const statistics = await pacsJson(fetcher, server, `${root}/studies/${encodeURIComponent(study.ID)}/statistics`)
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
  fetcher: UpstreamFetch = fetch,
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
