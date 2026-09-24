// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SHL Service Account — the `shlExchange` client, plus the default upstream
 * FHIR server URL.
 *
 * The SHL proxy and the SHL→Consent mirror both need a service-account token
 * for the same client, so the binding to `shlExchange` lives here once. The
 * grant itself is generic and shared with other machine callers — see
 * `@/lib/service-account`.
 */
import { config } from '@/config'
import { getAllServers } from '@/lib/fhir-server-store'
import { requestServiceAccountToken } from '@/lib/service-account'

/** Default scope: read-only patient data (SHL proxy fetches). */
const DEFAULT_SCOPE = 'openid patient/*.read'

/**
 * Get a Keycloak service account token for the `shlExchange` client, cached per
 * scope until near-expiry. Pass a wider scope (e.g. including `patient/*.write`)
 * for write operations such as mirroring an SHL into a Consent resource.
 */
export async function getServiceAccountToken(scope: string = DEFAULT_SCOPE): Promise<string> {
  return requestServiceAccountToken({
    clientId: config.shlExchange.clientId,
    clientSecret: config.shlExchange.clientSecret,
    scope,
  })
}

/** Resolve the first available upstream FHIR server URL. */
/** The upstream FHIR server SHLs are minted against: its URL and its store identifier. */
export async function getDefaultFhirServer(): Promise<{ url: string; identifier: string }> {
  const servers = await getAllServers()
  if (servers.length > 0) return { url: servers[0].url, identifier: servers[0].identifier }
  return { url: config.fhir.serverBases[0] || 'http://localhost:8081/fhir', identifier: '' }
}

export async function getDefaultFhirServerUrl(): Promise<string> {
  return (await getDefaultFhirServer()).url
}
