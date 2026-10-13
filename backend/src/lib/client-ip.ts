// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'

/** The part of Bun's server that knows the socket peer; Elysia passes it as `server`. */
export interface PeerAddressSource {
  requestIP(request: Request): { address: string } | null
}

export interface ClientIpOptions {
  /** Defaults to TRUSTED_PROXY_HOPS. */
  trustedHops?: number
  /** The socket peer, when the caller already has it. */
  peer?: string | null
  /** Resolves the socket peer from the request when `peer` is not given. */
  server?: PeerAddressSource | null
}

type HeaderSource = Request | Headers | Record<string, string | undefined>

function forwardedFor(source: HeaderSource): string | null {
  if (source instanceof Request) return source.headers.get('x-forwarded-for')
  if (source instanceof Headers) return source.get('x-forwarded-for')
  return source['x-forwarded-for'] ?? null
}

/**
 * The client address given a socket peer and `trustedHops` proxies that each append to
 * X-Forwarded-For. Entries left of the trusted ones were written by the client and are ignored.
 */
export function forwardedClientIp(
  header: string | null | undefined,
  peer: string | null | undefined,
  trustedHops: number,
): string | undefined {
  const fallback = peer || undefined
  if (trustedHops <= 0) return fallback
  const chain = (header ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  if (chain.length === 0) return fallback
  return chain[Math.max(0, chain.length - trustedHops)]
}

/** The requesting client's IP, trusting only the configured proxy hops. */
export function clientIp(source: HeaderSource, options: ClientIpOptions = {}): string | undefined {
  const trustedHops = options.trustedHops ?? config.network.trustedProxyHops
  const peer = options.peer ?? (source instanceof Request ? options.server?.requestIP(source)?.address : undefined)
  return forwardedClientIp(forwardedFor(source), peer, trustedHops)
}
