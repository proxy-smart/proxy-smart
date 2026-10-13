// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { status } from 'elysia'
import { config } from '../config'
import { TtlCache } from './cache/ttl-cache'
import { clientIp, type PeerAddressSource } from './client-ip'

export interface RateLimitOptions {
  windowMs?: number
  /** Requests allowed per window, read per request so configuration can change at runtime. 0 disables. */
  max: () => number
  message?: string
  keyFn?: (context: RateLimitContext) => string
}

/** The slice of an Elysia handler context the limiter reads and writes. */
export interface RateLimitContext {
  request: Request
  server: PeerAddressSource | null
  set: { status?: number | string; headers: Record<string, string | number> }
}

interface Window {
  count: number
  resetAt: number
}

const MAX_TRACKED_CLIENTS = 100_000

const byClientIp = ({ request, server }: RateLimitContext) => clientIp(request, { server }) ?? 'unknown'

/**
 * A fixed-window limiter to attach as a route's `transform`, so it runs per route and before body
 * validation; a malformed request still counts. Each call owns its own counters.
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs = 60_000, max, message = 'Too many requests, please try again later', keyFn = byClientIp } = options
  const windows = new TtlCache<Window>({ ttlMs: windowMs, maxEntries: MAX_TRACKED_CLIENTS, cleanupIntervalMs: 5 * 60_000 })

  return (context: RateLimitContext) => {
    const limit = max()
    if (limit <= 0) return

    const key = keyFn(context)
    const now = Date.now()
    let window = windows.get(key)
    if (!window) {
      window = { count: 0, resetAt: now + windowMs }
      windows.set(key, window, windowMs)
    }
    window.count++

    const { set } = context
    set.headers['X-RateLimit-Limit'] = String(limit)
    set.headers['X-RateLimit-Remaining'] = String(Math.max(0, limit - window.count))
    set.headers['X-RateLimit-Reset'] = String(Math.ceil(window.resetAt / 1000))

    if (window.count > limit) {
      set.headers['Retry-After'] = String(Math.max(1, Math.ceil((window.resetAt - now) / 1000)))
      throw status(429, { error: 'too_many_requests', error_description: message })
    }
  }
}

/** One limiter per OAuth credential endpoint, sized by AUTH_RATE_LIMIT_PER_MINUTE and off by default. */
export function authEndpointRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    max: () => config.rateLimit.authPerMinute,
    message: 'Too many requests to this endpoint, please try again later',
  })
}
