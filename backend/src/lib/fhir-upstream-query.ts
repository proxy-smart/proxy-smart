// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from './logger'
import { isRecord } from './type-guards'
import type { UpstreamFetch } from './upstream-fetch'

export interface UpstreamQueryContext {
  serverName: string
  authHeader: string
  upstreamFetch: UpstreamFetch
}

/** Entry count of an upstream FHIR Bundle, 0 when absent or not a list. */
export function bundleEntryCount(bundle: Record<string, unknown>): number {
  const entry = bundle.entry
  return Array.isArray(entry) ? entry.length : 0
}

/** An access-control lookup on the upstream server; null on any failure, so callers fail closed. */
export async function upstreamFhirQuery(
  ctx: UpstreamQueryContext,
  url: string,
  description: string,
): Promise<Record<string, unknown> | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/fhir+json' }
    if (ctx.authHeader) headers.Authorization = ctx.authHeader

    const resp = await ctx.upstreamFetch(url, { method: 'GET', headers })
    if (!resp.ok) {
      logger.fhir.warn(`Upstream ${description} failed`, {
        server: ctx.serverName,
        status: resp.status,
        statusText: resp.statusText,
      })
      return null
    }
    const body: unknown = await resp.json()
    return isRecord(body) ? body : null
  } catch (err) {
    logger.fhir.error(`Upstream ${description} error`, {
      server: ctx.serverName,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
