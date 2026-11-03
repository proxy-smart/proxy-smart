// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { checkExternalUrl, readTextCapped, type ExternalUrlCheck } from '@proxy-smart/auth'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import { config } from '@/config'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { isRecord } from '@/lib/type-guards'

const MAX_DOCUMENT_BYTES = 1_000_000
const OIDC_PROVIDERS: ReadonlySet<string> = new Set(['oidc', 'keycloak-oidc'])
const DISCOVERY_PATH = '/.well-known/openid-configuration'

export type IdpCheckName = 'discovery' | 'jwks' | 'metadata' | 'authorization' | 'token' | 'sso'
export type IdpConnectionStatus = 'reachable' | 'unreachable' | 'untested'

export interface IdpConnectionCheck {
  name: IdpCheckName
  url: string
  reachable: boolean
  httpStatus?: number
  reason?: string
  durationMs: number
}

export interface IdpConnectionTestResult {
  alias: string
  status: IdpConnectionStatus
  message: string
  checks: IdpConnectionCheck[]
}

export interface IdpConnectionTestDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  checkUrl: (url: string) => Promise<ExternalUrlCheck>
  timeoutMs: number
}

/** What a fetched document must hold; null when it qualifies, else why not. */
type DocumentRule = (text: string) => string | null

interface Probe {
  name: IdpCheckName
  url: string
  document?: DocumentRule
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function discoveryRule(expectedIssuer: string | undefined): DocumentRule {
  return (text) => {
    const doc = parsedObject(text)
    if (!doc || typeof doc.issuer !== 'string') return 'The answer is not an OpenID Connect discovery document'
    if (expectedIssuer && doc.issuer.replace(/\/$/, '') !== expectedIssuer.replace(/\/$/, '')) {
      return `The discovery document names issuer ${doc.issuer}, not the configured ${expectedIssuer}`
    }
    return null
  }
}

const jwksRule: DocumentRule = (text) => {
  const doc = parsedObject(text)
  return doc && Array.isArray(doc.keys) ? null : 'The answer is not a JSON Web Key Set'
}

const samlMetadataRule: DocumentRule = (text) =>
  text.includes('EntityDescriptor') ? null : 'The answer is not SAML metadata (no EntityDescriptor)'

function configValue(provider: IdentityProviderRepresentation, key: string): string | undefined {
  const value = provider.config?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The URLs this provider is configured with that Keycloak will call, and what each must answer. */
function probesFor(provider: IdentityProviderRepresentation): Probe[] {
  const providerId = provider.providerId ?? ''
  const value = (key: string) => configValue(provider, key)
  const endpoints = (pairs: Array<[IdpCheckName, string | undefined]>): Probe[] =>
    pairs.flatMap(([name, url]) => (url ? [{ name, url }] : []))

  if (providerId === 'saml') {
    const metadata = value('metadataDescriptorUrl')
    return metadata ? [{ name: 'metadata', url: metadata, document: samlMetadataRule }] : endpoints([['sso', value('singleSignOnServiceUrl')]])
  }
  if (providerId === 'oauth2') return endpoints([['authorization', value('authorizationUrl')], ['token', value('tokenUrl')]])
  if (!OIDC_PROVIDERS.has(providerId)) return []

  const issuer = value('issuer')
  const discovery = value('metadataDescriptorUrl') ?? (issuer ? `${issuer.replace(/\/$/, '')}${DISCOVERY_PATH}` : undefined)
  const jwksUrl = value('useJwksUrl') === 'true' ? value('jwksUrl') : undefined
  const keys: Probe[] = jwksUrl ? [{ name: 'jwks', url: jwksUrl, document: jwksRule }] : []
  if (discovery) return [{ name: 'discovery', url: discovery, document: discoveryRule(issuer) }, ...keys]
  return [...endpoints([['authorization', value('authorizationUrl')], ['token', value('tokenUrl')]]), ...keys]
}

function failureReason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `No answer within ${timeoutMs} ms`
  return error instanceof Error ? error.message : String(error)
}

async function runProbe(probe: Probe, deps: IdpConnectionTestDeps): Promise<IdpConnectionCheck> {
  const started = performance.now()
  const done = (outcome: Omit<IdpConnectionCheck, 'name' | 'url' | 'durationMs'>): IdpConnectionCheck =>
    ({ name: probe.name, url: probe.url, ...outcome, durationMs: Math.round(performance.now() - started) })

  const allowed = await deps.checkUrl(probe.url)
  if (!allowed.valid) return done({ reachable: false, reason: `Not tested: ${allowed.reason}` })

  try {
    const response = await deps.fetch(probe.url, {
      method: 'GET',
      headers: { Accept: probe.name === 'metadata' ? 'application/samlmetadata+xml, application/xml' : 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    const httpStatus = response.status
    if (!probe.document) {
      await response.body?.cancel()
      return done({ reachable: true, httpStatus })
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      return done({ reachable: false, httpStatus, reason: location ? `Redirects to ${location}, which is not followed` : `HTTP ${httpStatus}` })
    }
    const problem = probe.document(await readTextCapped(response, MAX_DOCUMENT_BYTES))
    return done(problem ? { reachable: false, httpStatus, reason: problem } : { reachable: true, httpStatus })
  } catch (error) {
    return done({ reachable: false, reason: failureReason(error, deps.timeoutMs) })
  }
}

const defaultDeps = (): IdpConnectionTestDeps => ({
  fetch: (url, init) => fetch(url, init),
  checkUrl: (url) => checkExternalUrl(url, outboundUrlPolicy),
  timeoutMs: config.keycloak.idpConnectionTestTimeoutMs,
})

/** Calls only the URLs stored on the provider, under the outbound URL policy, without following redirects. */
export async function testIdentityProviderConnection(
  provider: IdentityProviderRepresentation,
  deps: IdpConnectionTestDeps = defaultDeps(),
): Promise<IdpConnectionTestResult> {
  const alias = provider.alias ?? ''
  const probes = probesFor(provider).filter((probe, i, all) => all.findIndex((other) => other.url === probe.url) === i)
  if (probes.length === 0) {
    return {
      alias,
      status: 'untested',
      message: `The ${provider.providerId ?? 'unknown'} provider has no configured URL to test; its endpoints are built into Keycloak.`,
      checks: [],
    }
  }
  const checks = await Promise.all(probes.map((probe) => runProbe(probe, deps)))
  const failed = checks.filter((check) => !check.reachable)
  return {
    alias,
    status: failed.length === 0 ? 'reachable' : 'unreachable',
    message: failed.length === 0
      ? `Reached ${checks.length} configured URL${checks.length === 1 ? '' : 's'}.`
      : failed.map((check) => `${check.name}: ${check.reason ?? 'unreachable'}`).join('; '),
    checks,
  }
}
