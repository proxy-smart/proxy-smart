// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fhirResourceUrlFor, type FHIRServerInfo } from '@/lib/fhir-server-store'
import { checkExternalUrlSyntax } from '@proxy-smart/auth'
import { outboundUrlPolicy } from '@/lib/url-validation'
import type { FhirServerInfoResponseType, FhirServerResponseType } from '@/schemas'

type ServerCoreFields = Omit<FhirServerInfoResponseType, 'endpoints'>

export function serverCoreFields(server: FHIRServerInfo): ServerCoreFields {
  return {
    name: server.name,
    url: server.url,
    fhirVersion: server.metadata.fhirVersion,
    serverVersion: server.metadata.serverVersion,
    serverName: server.metadata.serverName,
    supported: server.metadata.supported,
    smartCapabilities: server.metadata.smartCapabilities,
    strictCapabilities: server.strictCapabilities ?? false,
    mcpEnabled: server.mcpEnabled ?? false,
    organizationIds: server.organizationIds,
  }
}

export function proxyServerEndpoints(server: FHIRServerInfo) {
  const base = fhirResourceUrlFor(server)
  return { base, smartConfig: `${base}/.well-known/smart-configuration`, metadata: `${base}/metadata` }
}

export function fhirServerView(server: FHIRServerInfo): FhirServerResponseType {
  return { id: server.identifier, ...serverCoreFields(server), endpoints: proxyServerEndpoints(server) }
}

/** Why an admin-supplied FHIR base URL is refused, or undefined when it is acceptable. */
export function serverUrlRejection(url: string): string | undefined {
  if (!URL.canParse(url)) return 'Invalid URL format'
  const check = checkExternalUrlSyntax(url, { ...outboundUrlPolicy, allowSingleLabelHosts: true })
  return check.valid ? undefined : `URL rejected: ${check.reason}`
}

/** The 400 body for a server whose metadata could not be read, or undefined for any other failure. */
export function metadataFailure(error: unknown): { error: string; details: string } | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.message.includes('Failed to fetch FHIR metadata')) {
    return { error: 'Unable to connect to FHIR server or server is not responding', details: error.message }
  }
  if (error.message.includes('Invalid FHIR server')) {
    return { error: 'Server is not a valid FHIR server', details: error.message }
  }
  return undefined
}
