// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'

/** The proxy's own base URL for one FHIR server and version. */
export function proxyBaseUrl(target: { serverName: string; fhirVersion: string }): string {
  return `${config.baseUrl}/${config.name}/${target.serverName}/${target.fhirVersion}`
}
