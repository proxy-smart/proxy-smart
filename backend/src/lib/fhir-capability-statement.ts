// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord } from './type-guards'

interface CapSearchParam {
  name: string
  type: string
  definition?: string
  documentation?: string
}

interface CapInteraction {
  code: string
}

interface CapOperation {
  name: string
  definition: string
  documentation?: string
}

interface CapSecurity {
  cors?: boolean
  service?: { coding?: { code?: string; system?: string }[]; text?: string }[]
  description?: string
}

interface CapResource {
  type: string
  profile?: string
  supportedProfile?: string[]
  documentation?: string
  interaction?: CapInteraction[]
  versioning?: string              // no-version | versioned | versioned-update
  readHistory?: boolean
  updateCreate?: boolean
  conditionalCreate?: boolean
  conditionalRead?: string         // not-supported | modified-since | not-match | full-support
  conditionalUpdate?: boolean
  conditionalDelete?: string       // not-supported | single | multiple
  referencePolicy?: string[]       // literal | logical | resolves | enforced | local
  searchInclude?: string[]
  searchRevInclude?: string[]
  searchParam?: CapSearchParam[]
  operation?: CapOperation[]
}

interface CapRest {
  mode: string
  documentation?: string
  security?: CapSecurity
  resource?: CapResource[]
  interaction?: CapInteraction[]
  searchParam?: CapSearchParam[]
  operation?: CapOperation[]
  compartment?: string[]
}

export interface CapabilityStatementRaw {
  resourceType: 'CapabilityStatement'
  status?: string                  // draft | active | retired | unknown
  kind?: string                    // instance | capability | requirements
  fhirVersion?: string
  version?: string
  format?: string[]                // json | xml | ttl | mime types
  patchFormat?: string[]
  implementationGuide?: string[]
  software?: { name?: string; version?: string; releaseDate?: string }
  implementation?: { description?: string; url?: string }
  rest?: CapRest[]
}

export function isCapabilityStatement(value: unknown): value is CapabilityStatementRaw {
  return isRecord(value) && value.resourceType === 'CapabilityStatement'
}
