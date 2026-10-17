// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Advertise this proxy's OAuth endpoints in the CapabilityStatement it serves: HAPI leaves
 * `rest[].security` empty, so clients doing CapabilityStatement-based SMART discovery found none.
 * The values come from the service that builds smart-configuration, so the two cannot disagree.
 */

import { getSmartSecurityServiceVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-SmartSecurityServiceVS'
import { isRecord } from './type-guards'

const OAUTH_URIS = 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris'
const SMART_SECURITY_SERVICE = getSmartSecurityServiceVSConcept('SMART-on-FHIR')

/** The endpoints worth advertising, in SMART's extension names. Absent ones are simply omitted. */
const ADVERTISED = [
  ['authorize', 'authorization_endpoint'],
  ['token', 'token_endpoint'],
  ['register', 'registration_endpoint'],
  ['introspect', 'introspection_endpoint'],
  ['revoke', 'revocation_endpoint'],
  ['manage', 'management_endpoint'],
] as const

/** Only the fields this module reads; the real document has many more. */
export interface SmartEndpoints {
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
  introspection_endpoint?: string
  revocation_endpoint?: string
  management_endpoint?: string
}

interface Extension {
  url: string
  valueUri?: string
  extension?: Extension[]
}

interface RestEntry {
  mode?: string
  security?: {
    service?: { coding?: { system?: string; code?: string; display?: string }[]; text?: string }[]
    extension?: Extension[]
  }
}

interface CapabilityStatement {
  resourceType?: string
  rest?: RestEntry[]
}

/**
 * Add `oauth-uris` and the SMART security service to every server-mode `rest` entry. Never throws
 * and never replaces: a non-CapabilityStatement body, or an entry already advertising `oauth-uris`,
 * passes through untouched.
 */
export function withSmartSecurity(body: string, endpoints: SmartEndpoints): string {
  if (!endpoints.authorization_endpoint || !endpoints.token_endpoint) return body

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(parsed)) return body

  const statement: CapabilityStatement = parsed
  if (statement.resourceType !== 'CapabilityStatement' || !Array.isArray(statement.rest)) return body

  let changed = false
  for (const entry of statement.rest) {
    // `mode` is optional upstream; absent means the only rest entry, which is the server's.
    if (entry.mode && entry.mode !== 'server') continue
    if (annotate(entry, endpoints)) changed = true
  }

  return changed ? JSON.stringify(statement) : body
}

function annotate(entry: RestEntry, endpoints: SmartEndpoints): boolean {
  const security = (entry.security ??= {})
  const extensions = (security.extension ??= [])
  if (extensions.some((extension) => extension.url === OAUTH_URIS)) return false

  const uris: Extension[] = []
  for (const [name, field] of ADVERTISED) {
    const value = endpoints[field]
    if (value) uris.push({ url: name, valueUri: value })
  }
  extensions.push({ url: OAUTH_URIS, extension: uris })

  const services = (security.service ??= [])
  const declared = services.some((service) =>
    service.coding?.some((coding) => coding.code === 'SMART-on-FHIR'),
  )
  if (!declared) {
    services.push({
      coding: [{ ...SMART_SECURITY_SERVICE }],
      text: 'OAuth2 using SMART-on-FHIR profile (see http://www.hl7.org/fhir/smart-app-launch)',
    })
  }

  return true
}
