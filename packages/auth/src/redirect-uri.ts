// RFC 6749 §3.1.2.3 / §10.6: the proxy rewrites redirect_uri for the IdP, so it must validate it the way Keycloak would.

/** An empty list rejects every redirect_uri. */
export type GetRegisteredRedirectUris = (clientId: string) => Promise<string[]>

/** Unregistered requested URIs fall back to baseUrl, so /logout is not an open redirect. */
export function resolvePostLogoutUri(opts: {
  baseUrl: string
  sessionRedirectUri?: string
  requested?: string
  registered?: readonly string[]
}): string {
  const fallback = `${opts.baseUrl.replace(/\/+$/, '')}/`

  if (opts.sessionRedirectUri) {
    try {
      return new URL(opts.sessionRedirectUri).origin
    } catch {
      return fallback
    }
  }

  if (opts.requested && isRedirectUriRegistered(opts.requested, opts.registered ?? [])) {
    return opts.requested
  }

  return fallback
}

/** Exact match (RFC 6749 §3.1.2.3), or a single trailing-`*` Keycloak wildcard. */
export function isRedirectUriRegistered(candidate: string, registered: readonly string[]): boolean {
  return registered.some((pattern) => pattern === candidate || (pattern.endsWith('*') && matchesWildcard(pattern.slice(0, -1), candidate)))
}

/** RFC 8252 §7.3: native apps listen on an ephemeral loopback port, the one case a port wildcard serves. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PORT_WILDCARD_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#@[\]]+|\[[^\]]+\]):$/i

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** Keycloak trailing `*`, hardened: same origin after parsing, no userinfo, no dot-segment escape. */
function matchesWildcard(prefix: string, candidate: string): boolean {
  const port = PORT_WILDCARD_PREFIX.exec(prefix)
  if (port) {
    const rest = candidate.slice(prefix.length)
    return LOOPBACK_HOSTS.has(port[1].toLowerCase()) && candidate.startsWith(prefix) && /^\d+(?:[/?#]|$)/.test(rest)
  }

  if (!candidate.startsWith(prefix)) {
    return prefix.endsWith('/') && candidate.split(/[?#]/, 1)[0] === prefix.slice(0, -1)
  }

  const url = parseUrl(candidate)
  if (!url || url.username || url.password) return false
  const anchor = parseUrl(prefix)
  return !anchor || (url.origin === anchor.origin && url.href.startsWith(anchor.href))
}

export const DEFAULT_CALLBACK_PATH = '/auth/smart-callback'

function httpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** A `https://app/*` wildcard has a literal origin and counts; any other `*` does not. */
function redirectOrigin(uri: string): URL | undefined {
  if (!uri.includes('*')) return httpUrl(uri)
  const prefix = uri.slice(0, -1)
  if (!uri.endsWith('/*') || prefix.includes('*')) return undefined
  return httpUrl(prefix)
}

/** Root of a proxy host is never a client's home; an app under a proxy path still can be. */
export function isProxyRoot(url: string | undefined, proxyUrls: readonly (string | undefined)[]): boolean {
  const parsed = httpUrl(url)
  if (!parsed || (parsed.pathname !== '/' && parsed.pathname !== '')) return false
  return proxyUrls.some((proxyUrl) => httpUrl(proxyUrl)?.origin === parsed.origin)
}

/** Keycloak `baseUrl`: client_uri, then launch URL, then first non-proxy redirect origin; a proxy callback on any host is skipped. */
export function resolveClientHomeUrl(opts: {
  clientUri?: string
  launchUrl?: string
  redirectUris?: readonly string[]
  proxyBaseUrl?: string
  proxySiteUrl?: string
}): string | undefined {
  const declared = httpUrl(opts.clientUri) ?? httpUrl(opts.launchUrl)
  if (declared) return declared.toString()

  const proxyUrls = [opts.proxyBaseUrl, opts.proxySiteUrl]
  for (const uri of opts.redirectUris ?? []) {
    const url = redirectOrigin(uri)
    if (!url || url.pathname.endsWith(DEFAULT_CALLBACK_PATH) || isProxyRoot(url.origin, proxyUrls)) continue
    return url.origin
  }
  return undefined
}
