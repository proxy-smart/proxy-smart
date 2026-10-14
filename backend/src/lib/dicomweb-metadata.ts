// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * WADO-RS metadata preloading for Cornerstone3D.
 *
 * Cornerstone's built-in wadors metadata provider only works if instance
 * metadata was first inserted into its internal metaDataManager via
 * `metaDataManager.add(imageId, metadata)`.
 *
 * This module provides a pure, framework-agnostic function that:
 * 1. Fetches WADO-RS series-level metadata (DICOM JSON)
 * 2. Maps each instance to its Cornerstone imageId
 * 3. Returns entries ready to be fed into the metaDataManager
 *
 * Usage in a Cornerstone viewer:
 * ```ts
 * import { wadors } from "@cornerstonejs/dicom-image-loader"
 * const entries = await fetchSeriesMetadataEntries(base, study, series, headers)
 * for (const { imageId, metadata } of entries) {
 *   wadors.metaDataManager.add(imageId, metadata)
 * }
 * ```
 */

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/** DICOM tag for SOP Instance UID in DICOM JSON */
const SOP_INSTANCE_UID_TAG = '00080018'

/** One instance in DICOM JSON (PS3.18 F.2): attributes keyed by tag. */
const DicomJsonInstance = Type.Record(
  Type.String(),
  Type.Object({ Value: Type.Optional(Type.Array(Type.Unknown())), vr: Type.Optional(Type.String()) }),
)

/** An imageId + its full DICOM JSON metadata, ready for Cornerstone */
export interface MetadataEntry {
  imageId: string
  metadata: Static<typeof DicomJsonInstance>
}

/**
 * Fetch WADO-RS series metadata and return Cornerstone-ready entries.
 *
 * Each entry pairs a `wadors:` imageId with the instance's DICOM JSON metadata,
 * which contains the tags Cornerstone needs (samplesPerPixel, rows, cols, etc.).
 *
 * @param wadoRsRoot  Base DICOMweb URL (e.g. `https://pacs.example.com/dicomweb`)
 * @param studyUID    DICOM Study Instance UID
 * @param seriesUID   DICOM Series Instance UID
 * @param headers     Optional fetch headers (e.g. `{ Authorization: "Bearer ..." }`)
 * @returns Array of `{ imageId, metadata }` entries (empty on failure)
 */
export async function fetchSeriesMetadataEntries(
  wadoRsRoot: string,
  studyUID: string,
  seriesUID: string,
  headers?: HeadersInit,
): Promise<MetadataEntry[]> {
  const base = wadoRsRoot.replace(/\/+$/, '')
  const url = `${base}/studies/${studyUID}/series/${seriesUID}/metadata`

  let instances: unknown
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return []
    instances = await res.json()
  } catch {
    return []
  }
  if (!Array.isArray(instances)) return []

  const entries: MetadataEntry[] = []
  for (const inst of instances) {
    if (!Value.Check(DicomJsonInstance, inst)) continue
    const sopUID = inst[SOP_INSTANCE_UID_TAG]?.Value?.[0]
    if (typeof sopUID !== 'string' || !sopUID) continue

    const imageId = `wadors:${base}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}/frames/1`
    entries.push({ imageId, metadata: inst })
  }

  return entries
}
