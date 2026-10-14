// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * URL Shortener client for go.maxhealth.tech
 *
 * Shortens bulky SHL viewer URLs (which contain the full base64url-encoded
 * shlink payload in the # fragment) into compact links for QR codes and messaging.
 *
 * Note: This only shortens the human-facing viewer URL, NOT the SHL manifest URL.
 * The manifest URL (embedded in the SHL payload) must remain directly POST-able
 * per the SHL spec.
 */
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { config } from '@/config'
import { logger } from '@/lib/logger'

interface ShortenRequest {
  url: string
  slug?: string
  expires_at?: string
  max_uses?: number
}

/** The part of the shortener's answer this client relies on; it also returns slug, target_url and limits. */
const ShortenResponse = Type.Object({ short_url: Type.String() })

export interface ShortenOptions {
  /** Optional custom slug (1-64 chars, [A-Za-z0-9_-]) */
  slug?: string
  /** ISO 8601 expiration date (must be in the future) */
  expiresAt?: string
  /** Maximum number of redirects before the link returns 410 Gone */
  maxUses?: number
}

/**
 * Shorten a URL via the go.maxhealth.tech API.
 * Returns the short URL on success, or `null` if the shortener
 * is disabled or the request fails (graceful degradation).
 */
export async function shortenUrl(url: string, options?: ShortenOptions): Promise<string | null> {
  if (!config.urlShortener.enabled) return null

  try {
    const body: ShortenRequest = { url }
    if (options?.slug) body.slug = options.slug
    if (options?.expiresAt) body.expires_at = options.expiresAt
    if (options?.maxUses) body.max_uses = options.maxUses

    const res = await fetch(`${config.urlShortener.baseUrl}/api/shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      logger.auth.warn('URL shortener returned non-OK', {
        status: res.status,
        body: await res.text().catch(() => ''),
      })
      return null
    }

    const data: unknown = await res.json()
    if (!Value.Check(ShortenResponse, data)) {
      logger.auth.warn('URL shortener answered without a short_url')
      return null
    }
    return data.short_url
  } catch (error) {
    logger.auth.warn('URL shortener request failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
