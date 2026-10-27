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
import { pacsAuthHeader } from '@/lib/dicom-pacs'
import { getDefaultDicomServer } from '@/lib/dicom-server-config'
import type { DicomServerConfigType, DicomStorageUsageType } from '@/schemas'

const LOOKUP_CONCURRENCY = 6

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

interface PacsTarget {
  baseUrl: string
  auth: string | null
  timeoutMs: number
}

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

function targetOf(server: DicomServerConfigType | null | undefined): PacsTarget | null {
  const resolved = server ?? getDefaultDicomServer()
  const baseUrl = resolved?.baseUrl ?? (config.dicomweb.enabled ? config.dicomweb.baseUrl : undefined)
  if (!baseUrl) return null
  return { baseUrl, auth: pacsAuthHeader(resolved), timeoutMs: resolved?.timeoutMs ?? config.dicomweb.timeoutMs }
}

async function pacsJson(fetcher: Fetch, target: PacsTarget, url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (target.auth) headers.set('authorization', target.auth)
  const response = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(target.timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function orthancRoot(fetcher: Fetch, target: PacsTarget): Promise<string | null> {
  return apiRoots.getOrLoad(target.baseUrl, async () => {
    const candidate = orthancRootOf(target.baseUrl)
    const system = await pacsJson(fetcher, target, `${candidate}/system`).catch(() => null)
    return isRecord(system) && typeof system.ApiVersion === 'number' ? candidate : null
  })
}

function byteCount(value: unknown): number {
  const bytes = typeof value === 'string' ? Number(value) : value
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('PACS reported no study size')
  return bytes
}

async function orthancStudyBytes(fetcher: Fetch, target: PacsTarget, root: string, studyUid: string): Promise<number> {
  const matches = await pacsJson(fetcher, target, `${root}/tools/lookup`, { method: 'POST', body: studyUid })
  const study = Array.isArray(matches) ? matches.find((m) => isRecord(m) && m.Type === 'Study') : undefined
  if (!isRecord(study) || typeof study.ID !== 'string') return 0
  const statistics = await pacsJson(fetcher, target, `${root}/studies/${encodeURIComponent(study.ID)}/statistics`)
  return byteCount(isRecord(statistics) ? statistics.DiskSize : undefined)
}

function studyBytes(fetcher: Fetch, target: PacsTarget, root: string, studyUid: string): Promise<number | null> {
  return studySizes
    .getOrLoad(`${target.baseUrl}|${studyUid}`, () => orthancStudyBytes(fetcher, target, root, studyUid))
    .catch((err: unknown) => {
      logger.fhir.warn('PACS study size lookup failed', { studyUid, error: err instanceof Error ? err.message : String(err) })
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
  server?: DicomServerConfigType | null,
  fetcher: Fetch = fetch,
): Promise<DicomStorageUsageType> {
  const unique = [...new Set(studyUids)]
  const target = targetOf(server)
  const root = target ? await orthancRoot(fetcher, target) : null
  if (!target || !root) return { studies: unique.length, bytes: null, unmeasuredStudies: unique.length }

  const measured = await mapConcurrently(unique, LOOKUP_CONCURRENCY, (uid) => studyBytes(fetcher, target, root, uid))
  const known = measured.filter((bytes): bytes is number => bytes !== null)
  const anyMeasured = known.length > 0 || unique.length === 0
  return {
    studies: unique.length,
    bytes: anyMeasured ? known.reduce((sum, bytes) => sum + bytes, 0) : null,
    unmeasuredStudies: unique.length - known.length,
  }
}
