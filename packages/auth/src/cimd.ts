// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// MCP 2026-07-28 Client ID Metadata Documents: the IdP has no record of a CIMD client, so the proxy validates redirect_uris against the document.

import type { SmartProxyLogger } from './types'
import { checkExternalUrl, readTextCapped, type ExternalUrlPolicy } from './external-url'

export interface CimdDocument {
  /** MUST equal the document URL exactly. */
  client_id: string
  client_name?: string
  redirect_uris: string[]
}

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

/** Spec: https AND a path component, so a bare origin is never a metadata document. */
export function isCimdClientId(clientId: string | undefined): boolean {
  if (!clientId) return false
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && url.pathname.length > 1
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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('document is not a JSON object')
  }
  const clientId = 'client_id' in body ? body.client_id : undefined

  if (clientId !== expectedClientId) {
    throw new Error(`client_id ${String(clientId)} does not match document URL ${expectedClientId}`)
  }

  const uris = 'redirect_uris' in body ? body.redirect_uris : undefined
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
    client_name: 'client_name' in body && typeof body.client_name === 'string' ? body.client_name : undefined,
    redirect_uris,
  }
}

export interface CimdOptions {
  logger?: SmartProxyLogger
  fetchImpl?: typeof fetch
  urlPolicy?: ExternalUrlPolicy
}

/** Fail-closed: any failure returns [] so an unverified document never authorises a redirect. */
export async function resolveCimdRedirectUris(
  clientId: string,
  opts: CimdOptions = {},
): Promise<string[]> {
  const { logger } = opts
  const doFetch = opts.fetchImpl ?? fetch

  const now = Date.now()
  const cached = cache.get(clientId)
  if (cached && now < cached.expiresAt) return cached.doc.redirect_uris

  try {
    const target = await checkExternalUrl(clientId, opts.urlPolicy)
    if (!target.valid) {
      logger?.warn('CIMD: metadata document URL refused', { clientId, reason: target.reason })
      return []
    }

    const response = await doFetch(clientId, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    })

    if (!response.ok) {
      logger?.warn('CIMD: metadata document fetch failed', { clientId, status: response.status })
      return []
    }

    let text: string
    try {
      text = await readTextCapped(response, MAX_DOCUMENT_BYTES)
    } catch {
      logger?.warn('CIMD: metadata document too large', { clientId })
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      logger?.warn('CIMD: metadata document is not valid JSON', { clientId })
      return []
    }

    const doc = validateCimdDocument(parsed, clientId)

    const ttl = ttlFromCacheControl(response.headers.get('cache-control')) ?? DEFAULT_TTL_MS
    if (ttl > 0) cache.set(clientId, { doc, expiresAt: now + ttl })

    logger?.debug('CIMD: resolved metadata document', {
      clientId,
      redirectUris: doc.redirect_uris.length,
      ttlMs: ttl,
    })
    return doc.redirect_uris
  } catch (err) {
    logger?.warn('CIMD: could not resolve metadata document', {
      clientId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

export function clearCimdCache(): void {
  cache.clear()
}
