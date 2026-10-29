// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — OAuth Client ID Metadata Documents (CIMD)
 *
 * A CIMD client identifies itself with an https URL instead of a client id
 * registered at the authorization server, and publishes its own metadata —
 * crucially its `redirect_uris` — at that URL. MCP 2025-11-25 introduced it and
 * 2026-07-28 makes it the RECOMMENDED registration method, deprecating Dynamic
 * Client Registration.
 *
 * WHY THE PROXY MUST DO THIS ITSELF. Once the proxy intercepts the callback it
 * rewrites `redirect_uri` to its own, so the IdP never sees the client's real URI
 * and can no longer validate it — the proxy has taken that obligation on. For a
 * DCR client it discharges it by asking the IdP for the registered URIs. For a
 * CIMD client the IdP has no record of the client at all, so the only source of
 * truth is the document. Skipping the check is not an option (it is the
 * authorization-code-theft defence in RFC 6749 §10.6), and skipping interception
 * means silently delegating an authorization-server MUST to the IdP while still
 * advertising `client_id_metadata_document` support ourselves.
 *
 * The MCP spec (2026-07-28, Client Registration → For Authorization Servers) is
 * the checklist this module implements:
 *
 *   SHOULD fetch metadata documents when encountering URL-formatted client_ids
 *   MUST   validate that the fetched document's `client_id` matches the URL exactly
 *   SHOULD cache metadata respecting HTTP cache headers
 *   MUST   validate redirect URIs presented in an authorization request against
 *          those in the metadata document
 *   MUST   validate the document structure is valid JSON and contains required fields
 */

import type { SmartProxyLogger } from './types'
import { checkExternalUrl, readTextCapped, type ExternalUrlPolicy } from './external-url'

/** The subset of a CIMD document this proxy relies on. */
export interface CimdDocument {
  /** MUST equal the URL the document was fetched from, exactly. */
  client_id: string
  client_name?: string
  /** MUST be present and non-empty — the whole point of the fetch. */
  redirect_uris: string[]
}

interface CacheEntry {
  doc: CimdDocument
  expiresAt: number
}

/** Fallback lifetime when the response carries no usable cache directive. */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** Never trust a remote `max-age` beyond this — a stale allowlist is a security control. */
const MAX_TTL_MS = 60 * 60 * 1000

/** Give up rather than hold an authorize request open on a slow metadata host. */
const FETCH_TIMEOUT_MS = 5_000

/** Refuse absurd documents before parsing; a redirect_uris list is small. */
const MAX_DOCUMENT_BYTES = 256 * 1024

const cache = new Map<string, CacheEntry>()

/**
 * Is this `client_id` a CIMD URL?
 *
 * Per the spec the `client_id` URL MUST use the https scheme AND contain a path
 * component. The path requirement is not decoration: it is what stops a bare
 * origin from being treated as a metadata document.
 */
export function isCimdClientId(clientId: string | undefined): boolean {
  if (!clientId) return false
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && url.pathname.length > 1
  } catch {
    return false
  }
}

/** Parse `Cache-Control: max-age=N` into a clamped TTL, or null when absent/unusable. */
function ttlFromCacheControl(header: string | null): number | null {
  if (!header) return null
  const directives = header.toLowerCase()
  // `no-store`/`no-cache` mean re-fetch every time.
  if (directives.includes('no-store') || directives.includes('no-cache')) return 0
  const match = /max-age\s*=\s*(\d+)/.exec(directives)
  if (!match) return null
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, MAX_TTL_MS)
}

/**
 * Validate a parsed JSON body as a CIMD document for `expectedClientId`.
 *
 * @throws Error with a reason suitable for logging (never surfaced to the client,
 *   which only learns that its redirect_uri was not accepted).
 */
export function validateCimdDocument(body: unknown, expectedClientId: string): CimdDocument {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('document is not a JSON object')
  }
  const clientId = 'client_id' in body ? body.client_id : undefined

  // The anti-spoofing check: without it, any URL could vouch for any client id.
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

/** Options for {@link resolveCimdRedirectUris}. */
export interface CimdOptions {
  logger?: SmartProxyLogger
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  urlPolicy?: ExternalUrlPolicy
}

/**
 * Resolve the redirect URIs a CIMD client is allowed to use.
 *
 * Returns an EMPTY ARRAY on every failure — unreachable host, non-2xx, oversized
 * body, malformed JSON, `client_id` mismatch, missing `redirect_uris`. The caller
 * treats an empty allowlist as "reject every redirect_uri", so a metadata document
 * we could not verify can never authorise a redirect. Fail-closed is the only safe
 * direction here: the alternative is letting a fetch failure widen the allowlist.
 */
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

/** Drop cached documents. Exported for tests and admin invalidation. */
export function clearCimdCache(): void {
  cache.clear()
}
