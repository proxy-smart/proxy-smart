// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The DICOMweb authorization's view of FHIR: ImagingStudy searches run through the FHIR proxy
 * routes in-process, as the caller, so every FHIR access decision applies unchanged.
 */

import { config } from '../config'
import { getAllServers } from '../lib/fhir-server-store'
import { getRuntimeAccessControlConfig } from '../lib/runtime-config'
import { resolveCallerIdentity } from '../lib/caller-identity'
import { isRecord } from '../lib/type-guards'
import type { DicomAccessDeps, ImagingStudySearch } from '../lib/dicomweb-access'
import { fhirRoutes } from './fhir'

const DICOM_UID_SYSTEM = 'urn:dicom:uid'

/** The DICOM Study Instance UIDs a FHIR ImagingStudy bundle names. */
export function studyUidsOf(bundle: unknown): string[] {
  if (!isRecord(bundle) || !Array.isArray(bundle.entry)) return []
  const uids: string[] = []
  for (const entry of bundle.entry) {
    const resource = isRecord(entry) ? entry.resource : undefined
    const identifiers = isRecord(resource) && Array.isArray(resource.identifier) ? resource.identifier : []
    for (const identifier of identifiers) {
      if (!isRecord(identifier) || identifier.system !== DICOM_UID_SYSTEM || typeof identifier.value !== 'string') continue
      uids.push(identifier.value.replace(/^urn:oid:/, ''))
    }
  }
  return uids
}

async function searchImagingStudies(authHeader: string, query: string): Promise<ImagingStudySearch> {
  const [server] = await getAllServers()
  if (!server) return { status: 503, studyUids: [] }
  const path = `/${config.name}/${server.identifier}/${server.metadata.fhirVersion}/ImagingStudy?${query}`
  const response = await fhirRoutes.handle(
    new Request(`${config.baseUrl}${path}`, { headers: { authorization: authHeader, accept: 'application/fhir+json' } }),
  )
  if (response.status !== 200) return { status: response.status, studyUids: [] }
  return { status: 200, studyUids: studyUidsOf(await response.json().catch(() => null)) }
}

export const dicomAccessDeps: DicomAccessDeps = {
  mode: () => getRuntimeAccessControlConfig().roleBasedFiltering,
  searchImagingStudies,
  callerIdentity: (caller, authHeader) => resolveCallerIdentity(caller, authHeader),
}
