// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Cache for client_credentials tokens, keyed by whatever identifies the grant
 * (client id, or client id plus scope). Lifetime comes from the issuer's
 * `expires_in`. A failed fetch throws and caches nothing.
 */

import { TtlCache } from './ttl-cache'

export interface FetchedToken {
  token: string
  /** OAuth `expires_in`. Omitted falls back to `defaultLifetimeSeconds`. */
  expiresInSeconds?: number
}

export interface TokenCacheOptions {
  /** Drop the token this many seconds before the issuer stops accepting it. */
  safetyMarginSeconds?: number
  /** Assumed lifetime when the token response carries no `expires_in`. */
  defaultLifetimeSeconds?: number
}

const DEFAULT_SAFETY_MARGIN_SECONDS = 30
const DEFAULT_LIFETIME_SECONDS = 300
const MIN_LIFETIME_MS = 1_000

export class TokenCache {
  private readonly tokens: TtlCache<FetchedToken>
  private readonly safetyMarginSeconds: number
  private readonly defaultLifetimeSeconds: number

  constructor(options: TokenCacheOptions = {}) {
    this.safetyMarginSeconds = options.safetyMarginSeconds ?? DEFAULT_SAFETY_MARGIN_SECONDS
    this.defaultLifetimeSeconds = options.defaultLifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS
    this.tokens = new TtlCache<FetchedToken>({ ttlMs: this.defaultLifetimeSeconds * 1000 })
  }

  /** Cached token for `key`, or the result of `fetch`. Concurrent misses share one fetch. */
  async get(key: string, fetch: () => Promise<FetchedToken>): Promise<string> {
    const fetched = await this.tokens.getOrLoad(key, fetch, value => this.lifetimeMs(value))
    return fetched.token
  }

  delete(key: string): void {
    this.tokens.delete(key)
  }

  clear(): void {
    this.tokens.clear()
  }

  private lifetimeMs(value: FetchedToken): number {
    const seconds = (value.expiresInSeconds ?? this.defaultLifetimeSeconds) - this.safetyMarginSeconds
    return Math.max(MIN_LIFETIME_MS, seconds * 1000)
  }
}
