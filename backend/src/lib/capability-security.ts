// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Advertise THIS proxy's OAuth endpoints in the CapabilityStatement it serves.
 *
 * The upstream FHIR server does not know it is behind a SMART authorization layer: HAPI returns
 * `rest[].security` empty, and /metadata was passed through with URL rewriting only. So a client
 * doing the CapabilityStatement half of SMART discovery found no endpoints and gave up, even though
 * `.well-known/smart-configuration` next door was complete.
 *
 * SMART App Launch defines both, and the extension is the one clients have used since v1 —
 * @babelfhir-ts/smart-auth reads smart-configuration first and falls back here, and that fallback
 * dead-ended against our own server. The values come from the same service that builds
 * smart-configuration, so the two documents cannot disagree.
 */

import { isRecord } from './type-guards'

const OAUTH_URIS = 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris'
const RESTFUL_SECURITY_SERVICE = 'http://terminology.hl7.org/CodeSystem/restful-security-service'

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
 * Add the `oauth-uris` extension and the SMART security service coding to every server-mode `rest`
 * entry, and return the document as a string.
 *
 * NEVER THROWS AND NEVER REPLACES. A body that is not a CapabilityStatement, or a `rest` entry that
 * already advertises `oauth-uris`, is returned untouched — a server that knows its own endpoints
 * better than we do keeps them, and a malformed upstream response is still passed through rather
 * than turned into an error the client cannot act on.
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
      coding: [{ system: RESTFUL_SECURITY_SERVICE, code: 'SMART-on-FHIR', display: 'SMART-on-FHIR' }],
      text: 'OAuth2 using SMART-on-FHIR profile (see http://www.hl7.org/fhir/smart-app-launch)',
    })
  }

  return true
}
