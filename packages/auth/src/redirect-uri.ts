/**
 * @proxy-smart/auth — Redirect URI Allowlist Validation
 *
 * RFC 6749 §3.1.2.3 / §10.6: the authorization server MUST validate the
 * client's `redirect_uri` against the URIs registered for that client and
 * reject any value that does not match. Without this, an attacker can
 * register a public client (or hijack an existing client_id) and have the
 * authorization code delivered to an attacker-controlled URI.
 *
 * The proxy intercepts the SMART flow and rewrites the redirect_uri sent to
 * the IdP with its own callback, so the IdP can no longer validate the real
 * client URI. The proxy therefore MUST perform this validation itself — at
 * authorize time (fail-closed) and again at callback time (defense in depth).
 *
 * Matching replicates KEYCLOAK's redirect-URI matching, because the proxy
 * intercepts the flow and Keycloak never sees the real client URI — so the
 * proxy must make exactly the decision Keycloak would, or legitimate clients
 * break. That means:
 *   - exact string match (RFC 6749 §3.1.2.3), OR
 *   - Keycloak trailing-wildcard: a registered URI ending in `*` matches any
 *     suffix after the literal prefix (e.g. `https://app.example.com/*` matches
 *     `https://app.example.com/callback`).
 *
 * Only a SINGLE TRAILING `*` is honoured — never a mid-string glob — so a
 * different host can never be a prefix match (`https://app.example.com/*` does
 * NOT match `https://app.example.com.evil/cb`). Registrations WITHOUT a wildcard
 * stay strictly exact, so a same-prefix attacker URI
 * (`https://app.example.com/callback.attacker.evil/cb`) is still rejected.
 *
 * SMART asks for fixed, fully specified redirect URIs, and DCR registers exactly what the client
 * sends. Wildcards stay for the seeded realm clients, which serve several origins and dev ports.
 */

/**
 * Async source of a client's registered redirect URIs.
 * Returns the full list of redirect URIs registered for `clientId`
 * (e.g. from Keycloak's client config). An empty list means the client has
 * no registered URIs (or is unknown) — in which case every redirect_uri is
 * rejected.
 */
export type GetRegisteredRedirectUris = (clientId: string) => Promise<string[]>

/**
 * Where to send the browser after logout.
 *
 * A launch session's `clientRedirectUri` was already validated at authorize, so its origin is
 * trusted. Anything the caller supplies is not: unregistered values fall back to `baseUrl` rather
 * than being honoured, which is what stops /logout being an open redirect.
 */
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

/**
 * A Keycloak trailing wildcard, hardened: the candidate keeps the registration's origin after URL
 * parsing, carries no userinfo, and cannot leave the registered path through dot segments.
 */
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

/** Where the proxy receives the IdP's authorization response, unless a deployment overrides it. */
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

/**
 * The origin a registered redirect URI points the browser at. A Keycloak path wildcard
 * (`https://app/*`) is anchored to a literal origin, so it counts; any other `*` does not.
 */
function redirectOrigin(uri: string): URL | undefined {
  if (!uri.includes('*')) return httpUrl(uri)
  const prefix = uri.slice(0, -1)
  if (!uri.endsWith('/*') || prefix.includes('*')) return undefined
  return httpUrl(prefix)
}

/**
 * Whether a URL is the root of one of the proxy's own hosts (its API base or public site).
 * Such a page is never a client's home, while an app served under a proxy path still is.
 */
export function isProxyRoot(url: string | undefined, proxyUrls: readonly (string | undefined)[]): boolean {
  const parsed = httpUrl(url)
  if (!parsed || (parsed.pathname !== '/' && parsed.pathname !== '')) return false
  return proxyUrls.some((proxyUrl) => httpUrl(proxyUrl)?.origin === parsed.origin)
}

/**
 * A client's Home URL, which Keycloak stores as `baseUrl` and offers as "Back to application".
 * Unset, the theme falls back to the proxy's own origin.
 *
 * RFC 7591 `client_uri` wins, then the SMART launch URL, then the first redirect origin that is
 * not the proxy. A proxy callback is skipped on any host, so a client still registered with a
 * previous proxy host's callback does not send its users there. Undefined when nothing qualifies,
 * so the caller renders no link rather than a wrong one.
 */
export function resolveClientHomeUrl(opts: {
  clientUri?: string
  launchUrl?: string
  redirectUris?: readonly string[]
  proxyBaseUrl?: string
  /** The proxy's public site, when it differs from its API base. */
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
