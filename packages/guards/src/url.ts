// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Linear-time `value.replace(/\/+$/, '')`; the regex is quadratic on long slash runs (ReDoS). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--
  return end === value.length ? value : value.slice(0, end)
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** `.example.org` matches the apex and every subdomain, `*.example.org` subdomains only, anything else the exact host. */
export function hostMatchesDomain(host: string, pattern: string): boolean {
  const hostname = host.toLowerCase()
  const domain = pattern.trim().toLowerCase()
  if (domain.startsWith('*.')) return hostname.endsWith(domain.slice(1))
  if (domain.startsWith('.')) return hostname === domain.slice(1) || hostname.endsWith(domain)
  return domain.length > 0 && hostname === domain
}
