// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The Keycloak client a dynamic registration (RFC 7591) turns into, and the redirect URIs it may use. */

import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { resolveClientHomeUrl } from '@proxy-smart/auth'
import { config } from '@/config'
import { REGISTRATION_TOKEN_ATTRIBUTE } from '@/lib/registration-access-token'
import type { ClientRegistrationRequestType, ClientRegistrationSettingsType } from '@/schemas'
import { clientSecurityAttributes, withProxyCallback } from '../admin/smart-apps/client-config'

export type DcrClientKind = 'public' | 'confidential' | 'backend-service'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])
const MAX_PATTERN_INPUT = 2048
const DAY_MS = 24 * 60 * 60 * 1000

function parseUrl(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

function isLoopbackUri(uri: string): boolean {
  const url = parseUrl(uri)
  return url !== null && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * SMART requires fixed, fully specified redirect URIs: no wildcard, no fragment, and https unless
 * the host is loopback (RFC 8252 §7.3). The operator's requireHttps setting governs the scheme rule.
 */
export function redirectUriRejection(uris: readonly string[], requireHttps: boolean): string | null {
  for (const uri of uris) {
    if (uri.includes('*')) return `redirect_uri '${uri}' contains a wildcard; register every URI in full`
    if (uri.includes('#')) return `redirect_uri '${uri}' must not contain a fragment`
    const url = parseUrl(uri)
    if (!url) return `redirect_uri '${uri}' is not an absolute URI`
    if (REFUSED_SCHEMES.has(url.protocol)) return `redirect_uri '${uri}' uses the ${url.protocol} scheme, which cannot receive a redirect`
    const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
    if (requireHttps && url.protocol !== 'https:' && !loopbackHttp) {
      return `redirect_uri '${uri}' must use https (plain http is allowed only on a loopback host)`
    }
  }
  return null
}

export function redirectUriMatchesPatterns(uri: string, patterns: readonly string[]): boolean {
  if (uri.length > MAX_PATTERN_INPUT) return false
  return patterns.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(uri)
    } catch {
      return false
    }
  })
}

/**
 * A client with keys is a backend service when it asks for client_credentials. Without grant_types,
 * the earlier heuristic stands: keys and no loopback redirect.
 */
export function classifyRegistration(body: ClientRegistrationRequestType): DcrClientKind {
  if (!body.jwks_uri && !body.jwks) return 'public'
  if (body.grant_types) return body.grant_types.includes('client_credentials') ? 'backend-service' : 'confidential'
  return body.redirect_uris.some(isLoopbackUri) ? 'confidential' : 'backend-service'
}

/** A pure backend service (client_credentials only) never sends a user through the authorization endpoint. */
export function usesAuthorizationCode(body: ClientRegistrationRequestType, kind: DcrClientKind): boolean {
  return kind !== 'backend-service' || !body.grant_types || body.grant_types.includes('authorization_code')
}

export function registeredGrantTypes(kind: DcrClientKind, authorizationCode: boolean): string[] {
  if (!authorizationCode) return ['client_credentials']
  return kind === 'backend-service'
    ? ['authorization_code', 'client_credentials', 'refresh_token']
    : ['authorization_code', 'refresh_token']
}

function webOrigin(uri: string): string {
  return parseUrl(uri)?.origin ?? uri
}

export interface DcrClientInput {
  clientId: string
  body: ClientRegistrationRequestType
  settings: ClientRegistrationSettingsType
  registrationTokenHash: string
  now: number
}

export interface DcrClient {
  kind: DcrClientKind
  standardFlowEnabled: boolean
  representation: ClientRepresentation
}

/**
 * Every client with keys authenticates through the proxy, which validates the client's assertion and
 * forwards one it signed itself, so Keycloak must use federated-jwt bound to the proxy's signing IdP.
 */
export function buildDcrClient({ clientId, body, settings, registrationTokenHash, now }: DcrClientInput): DcrClient {
  const kind = classifyRegistration(body)
  const isConfidential = kind !== 'public'
  const isBackendService = kind === 'backend-service'
  const standardFlowEnabled = usesAuthorizationCode(body, kind)
  const clientAuthenticatorType = isConfidential ? 'federated-jwt' : 'none'
  const homeUrl = resolveClientHomeUrl({
    clientUri: body.client_uri,
    redirectUris: body.redirect_uris,
    proxyBaseUrl: config.baseUrl,
  })

  const representation: ClientRepresentation = {
    clientId,
    name: body.client_name || clientId,
    ...(homeUrl && { baseUrl: homeUrl }),
    description: `SMART App: ${body.client_name || 'Dynamic Client'}`,
    enabled: !settings.adminApprovalRequired,
    protocol: 'openid-connect',
    publicClient: !isConfidential,
    fullScopeAllowed: true,
    standardFlowEnabled,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    serviceAccountsEnabled: isBackendService,
    // A self-registered client is unvetted, so the user is asked; there is no user in client_credentials.
    consentRequired: (settings.requireConsent ?? true) && !isBackendService,
    redirectUris: withProxyCallback(body.redirect_uris, !standardFlowEnabled),
    webOrigins: body.redirect_uris.map(webOrigin),
    clientAuthenticatorType,
    attributes: {
      'smart_app': 'true',
      'smart.fhir_versions': body.fhir_versions?.join(',') || 'R4',
      'smart.launch_uris': body.launch_uris?.join(',') || '',
      'smart.client_uri': body.client_uri || '',
      'smart.logo_uri': body.logo_uri || '',
      'post.logout.redirect.uris': '+',
      'dynamic_registration': 'true',
      'registration_date': String(now),
      // RFC 7592: only the hash is kept; the plaintext is returned once.
      [REGISTRATION_TOKEN_ATTRIBUTE]: registrationTokenHash,
      'approval_required': String(settings.adminApprovalRequired),
      'approved': String(!settings.adminApprovalRequired),
      ...(settings.maxClientLifetime > 0 && {
        'expires_at': String(now + settings.maxClientLifetime * DAY_MS),
      }),
      ...clientSecurityAttributes({
        clientId,
        clientAuthenticatorType,
        standardFlowEnabled,
        serviceAccountsEnabled: isBackendService,
      }),
      ...(body.jwks_uri && { 'use.jwks.url': 'true', 'jwks.url': body.jwks_uri }),
      ...(body.jwks && { 'use.jwks.string': 'true', 'jwks.string': JSON.stringify(body.jwks) }),
    },
  }

  return { kind, standardFlowEnabled, representation }
}
