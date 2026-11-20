// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document): the proxy resolves and vets the
// document, and validates redirect_uris against it, before standing in for the client towards the IdP.

import { isRecord } from '@proxy-smart/guards'
import type { SmartProxyLogger } from './types'
import { checkExternalUrl, readTextCapped, type ExternalUrlPolicy } from './external-url'

export interface CimdDocument {
  /** MUST equal the document URL exactly. */
  client_id: string
  client_name?: string
  redirect_uris: string[]
  /** The whole document, RFC 7591 client metadata. */
  metadata: Record<string, unknown>
}

/** Why a CIMD client may not sign in, shown to the user rather than redirected (RFC 6749 §4.1.2.1). */
export interface CimdRefusal {
  error: 'invalid_request' | 'unauthorized_client' | 'temporarily_unavailable'
  error_description: string
}

/** Draft §4.1: no method built on a shared symmetric secret, since the document is public. */
const SHARED_SECRET_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt'])

interface CacheEntry {
  doc: CimdDocument
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

/** Cap on remote `max-age`: a stale allowlist is a security control. */
const MAX_TTL_MS = 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 5_000

const MAX_DOCUMENT_BYTES = 256 * 1024

const cache = new Map<string, CacheEntry>()

/** Draft §3: https, a path other than `/`, no dot segments, fragment or userinfo. Checked on the raw string, never normalised. */
export function isCimdClientId(clientId: string | undefined): clientId is string {
  if (!clientId || !clientId.startsWith('https://') || clientId.includes('#')) return false
  try {
    const url = new URL(clientId)
    if (url.username || url.password || url.pathname.length <= 1) return false
    const rawPath = clientId.slice(`https://${url.host}`.length).split('?', 1)[0]
    return rawPath.startsWith('/') && !rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  } catch {
    return false
  }
}

function ttlFromCacheControl(header: string | null): number | null {
  if (!header) return null
  const directives = header.toLowerCase()
  if (directives.includes('no-store') || directives.includes('no-cache')) return 0
  const match = /max-age\s*=\s*(\d+)/.exec(directives)
  if (!match) return null
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, MAX_TTL_MS)
}

/** @throws Error with a reason for logging only; never surfaced to the client. */
export function validateCimdDocument(body: unknown, expectedClientId: string): CimdDocument {
  if (!isRecord(body) || Array.isArray(body)) {
    throw new Error('document is not a JSON object')
  }
  const clientId = body.client_id

  if (clientId !== expectedClientId) {
    throw new Error(`client_id ${String(clientId)} does not match document URL ${expectedClientId}`)
  }

  if ('client_secret' in body || 'client_secret_expires_at' in body) {
    throw new Error('document carries a client_secret, which a public document must not')
  }
  const authMethod = body.token_endpoint_auth_method
  if (typeof authMethod === 'string' && SHARED_SECRET_AUTH_METHODS.has(authMethod)) {
    throw new Error(`token_endpoint_auth_method ${authMethod} relies on a shared secret`)
  }
  if (authMethod === 'private_key_jwt' && body.jwks === undefined && body.jwks_uri === undefined) {
    throw new Error('private_key_jwt requires jwks or jwks_uri')
  }

  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error('redirect_uris is missing or empty')
  }
  const redirect_uris: string[] = []
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error('redirect_uris contains a non-string entry')
    }
    let parsed: URL
    try {
      parsed = new URL(uri)
    } catch {
      throw new Error(`redirect_uris contains a value that is not an absolute URI: ${uri}`)
    }
    if (!parsed.host) throw new Error(`redirect_uri has no host: ${uri}`)
    redirect_uris.push(uri)
  }

  return {
    client_id: expectedClientId,
    client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
    redirect_uris,
    metadata: body,
  }
}

export interface CimdOptions {
  logger?: SmartProxyLogger
  fetchImpl?: typeof fetch
  urlPolicy?: ExternalUrlPolicy
}

/** Fail-closed: any failure returns null, and neither an error nor a rejected document is cached (draft §6.2). */
export async function resolveCimdDocument(
  clientId: string,
  opts: CimdOptions = {},
): Promise<CimdDocument | null> {
  const { logger } = opts
  const doFetch = opts.fetchImpl ?? fetch

  const now = Date.now()
  const cached = cache.get(clientId)
  if (cached && now < cached.expiresAt) return cached.doc

  try {
    const target = await checkExternalUrl(clientId, opts.urlPolicy)
    if (!target.valid) {
      logger?.warn('CIMD: metadata document URL refused', { clientId, reason: target.reason })
      return null
    }

    const response = await doFetch(clientId, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    })

    if (!response.ok) {
      logger?.warn('CIMD: metadata document fetch failed', { clientId, status: response.status })
      return null
    }

    let text: string
    try {
      text = await readTextCapped(response, MAX_DOCUMENT_BYTES)
    } catch {
      logger?.warn('CIMD: metadata document too large', { clientId })
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      logger?.warn('CIMD: metadata document is not valid JSON', { clientId })
      return null
    }

    const doc = validateCimdDocument(parsed, clientId)

    const ttl = ttlFromCacheControl(response.headers.get('cache-control')) ?? DEFAULT_TTL_MS
    if (ttl > 0) cache.set(clientId, { doc, expiresAt: now + ttl })

    logger?.debug('CIMD: resolved metadata document', {
      clientId,
      redirectUris: doc.redirect_uris.length,
      ttlMs: ttl,
    })
    return doc
  } catch (err) {
    logger?.warn('CIMD: could not resolve metadata document', {
      clientId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** The redirect URIs a CIMD client registered; [] when its document cannot be trusted. */
export async function resolveCimdRedirectUris(clientId: string, opts: CimdOptions = {}): Promise<string[]> {
  return (await resolveCimdDocument(clientId, opts))?.redirect_uris ?? []
}

export function clearCimdCache(): void {
  cache.clear()
}
