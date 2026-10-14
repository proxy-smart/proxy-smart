// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Token Audience Binding
 *
 * Centralised, config-driven audience model for access-token validation. SMART on
 * FHIR endpoints legitimately accept DIFFERENT audiences:
 *
 *   - admin / management + /mcp : tokens minted for the proxy's own client(s)
 *                                 (e.g. the admin-ui client id) — matched on
 *                                 `aud` OR `azp`.
 *   - FHIR proxy + DICOMweb     : per SMART App Launch, an app's access token
 *                                 carries `aud` = the FHIR resource server base
 *                                 URL (this proxy's FHIR base), NOT a client id.
 *
 * `validateToken` enforces audience by DEFAULT (fail-closed). Call sites pass the
 * audience(s) they accept; when none is passed, a config-derived default set
 * applies (proxy client id(s) + MCP endpoint + FHIR base(s) + configured external
 * audiences). This mirrors the authorize-time `validateAudience` in routes/auth/oauth.ts
 * so authorize and token validation agree on what audiences are legitimate.
 *
 * Escape hatch: `JWT_AUDIENCE_ENFORCEMENT=disabled` turns enforcement off (for
 * controlled debugging / migration). The default is secure.
 */

import { config } from '../config'

/** A single expected-audience matcher. */
export interface AudienceMatcher {
  /** The audience value or URL prefix. */
  value: string
  /**
   * 'exact'  — token aud/azp must equal `value` (client ids).
   * 'prefix' — token aud must equal `value` or start with `value` + path/query
   *            boundary (resource-server base URLs). Guards against prefix attacks
   *            (e.g. `<base>evil` does NOT match `<base>`).
   */
  mode: 'exact' | 'prefix'
}

/** Normalise a token `aud` claim (string | string[] | undefined) to a string array. */
export function normalizeAud(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud]
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string')
  return []
}

/** Is the audience-enforcement escape hatch engaged? Default: enforce. */
export function isAudienceEnforcementDisabled(): boolean {
  return process.env.JWT_AUDIENCE_ENFORCEMENT === 'disabled'
}

/** True when `candidate` matches the prefix matcher at a URL boundary (not a substring). */
function matchesPrefix(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true
  // Only treat as a match at a real path/query boundary so `<prefix>evil` fails.
  return (
    candidate.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') ||
    candidate.startsWith(prefix + '?')
  )
}

/**
 * Build the default set of acceptable audience matchers from config. Used when a
 * call site does not pass an explicit expected audience.
 */
export function getDefaultAudienceMatchers(): AudienceMatcher[] {
  const matchers: AudienceMatcher[] = []

  // The proxy's own clients — exact match on aud or azp. Two clients legitimately
  // produce proxy tokens: the admin WEBAPP browser client (admin-ui) and the
  // Keycloak admin-REST service account (admin-service). admin-ui MUST be included
  // independently of adminClientId, which is the service account on beta/prod —
  // otherwise admin-ui user tokens are rejected at every default-audience call
  // site (e.g. GET /auth/userinfo), breaking admin webapp login.
  if (config.keycloak.adminUiClientId) {
    matchers.push({ value: config.keycloak.adminUiClientId, mode: 'exact' })
  }
  if (config.keycloak.adminClientId) {
    matchers.push({ value: config.keycloak.adminClientId, mode: 'exact' })
  }

  // MCP endpoint resource URL (RFC 8707 resource indicator).
  matchers.push({ value: `${config.baseUrl}${config.mcp.path}`, mode: 'prefix' })

  // Proxy FHIR base prefix: {baseUrl}/{name}/... covers every server/version under it.
  matchers.push({ value: `${config.baseUrl}/${config.name}/`, mode: 'prefix' })

  // Configured upstream FHIR server bases (tokens may carry the raw resource base).
  for (const base of config.fhir.serverBases) {
    if (base) matchers.push({ value: base, mode: 'prefix' })
  }

  // External resource servers that use this proxy as their authorization server.
  for (const ext of config.accessControl.externalAudiences) {
    if (!ext) continue
    // Wildcard domains ('.example.com') are intentionally NOT expanded here;
    // they are handled by authorize-time validation. Token aud is matched on the
    // concrete resource URL the app was issued for.
    if (!ext.startsWith('.')) matchers.push({ value: ext, mode: 'prefix' })
  }

  return matchers
}

/** The Keycloak client holding the FHIR base as its `resource_url`: the FHIR resource server's own id. */
export const FHIR_RESOURCE_CLIENT_ID = 'fhir-resource-server'

/** Audiences the resource-indicators scope maps. fhir-* is export-owned but still needs a mapper. */
export const RESOURCE_AUDIENCE_CLIENT_IDS = [FHIR_RESOURCE_CLIENT_ID, 'mcp-resource-server'] as const

export function isResourceAudienceClient(clientId: string | undefined): boolean {
  return RESOURCE_AUDIENCE_CLIENT_IDS.some((id) => id === clientId)
}

/**
 * Acceptable audiences for the FHIR proxy + DICOMweb call sites. Per SMART App
 * Launch, an app's access token carries `aud` = the FHIR resource server base URL
 * — which, through this proxy, is the proxy FHIR base ({baseUrl}/{name}/...). We
 * also accept the configured upstream FHIR server base(s) for tokens minted
 * directly against them, as URL prefixes matched at a path boundary, and the FHIR
 * resource client's id, the only `aud` an RFC 8693 exchange can carry for it.
 */
export function getFhirResourceAudiences(): string[] {
  const auds = [`${config.baseUrl}/${config.name}/`, FHIR_RESOURCE_CLIENT_ID]
  for (const base of config.fhir.serverBases) {
    if (base) auds.push(base)
  }
  return auds
}

/** Acceptable audience for the MCP endpoint call site (RFC 8707 resource URL). */
export function getMcpResourceAudience(): string {
  return `${config.baseUrl}${config.mcp.path}`
}

/** Coerce a call-site `expected` audience (string | string[]) into matchers. */
function toMatchers(expected: string | string[]): AudienceMatcher[] {
  const values = Array.isArray(expected) ? expected : [expected]
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((value) => ({
      // URL-shaped audiences (FHIR base, MCP endpoint) match by prefix; bare
      // client ids match exactly.
      value,
      mode: value.includes('://') ? 'prefix' : 'exact',
    }))
}

/**
 * Decide whether a token's `aud`/`azp` satisfies the expected audience(s).
 *
 * @param aud      The token's `aud` claim (string | string[] | undefined).
 * @param azp      The token's `azp` claim (authorized party / client id).
 * @param expected Optional call-site expected audience(s). When omitted, the
 *                 config-derived default matcher set is used.
 * @returns true when the token is bound to an acceptable audience.
 */
export function isAudienceAccepted(
  aud: unknown,
  azp: unknown,
  expected?: string | string[],
): boolean {
  if (isAudienceEnforcementDisabled()) return true

  const matchers = expected !== undefined ? toMatchers(expected) : getDefaultAudienceMatchers()
  // Defensive: with no matchers there is nothing to bind to. Fail closed.
  if (matchers.length === 0) return false

  const auds = normalizeAud(aud)
  const azpStr = typeof azp === 'string' ? azp : null

  // `azp` only satisfies EXACT (client-id) matchers — it names the authorized
  // party (a client), never a resource-server URL.
  const candidatesExact = azpStr ? [...auds, azpStr] : auds

  return matchers.some((m) => {
    if (m.mode === 'exact') return candidatesExact.includes(m.value)
    // prefix matchers apply only to aud (resource URLs), not azp.
    return auds.some((a) => matchesPrefix(a, m.value))
  })
}
