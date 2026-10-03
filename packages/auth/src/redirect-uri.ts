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
 * Validate a candidate `redirect_uri` against a client's registered URIs,
 * matching Keycloak's behaviour: exact match, or a single trailing-`*` wildcard.
 *
 * @returns true if `candidate` exactly equals one of `registered`, or matches a
 *   trailing-wildcard pattern in `registered`.
 */
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

export function isRedirectUriRegistered(candidate: string, registered: readonly string[]): boolean {
  for (const pattern of registered) {
    // Exact string match (RFC 6749 §3.1.2.3).
    if (pattern === candidate) return true

    // Keycloak trailing-wildcard: `<prefix>*` matches any `candidate` that
    // starts with `<prefix>`. Because the prefix includes scheme + host (and
    // usually a trailing `/`), this cannot match a different host. We do NOT
    // honour `*` anywhere but the very end, so mid-string globs can't widen it.
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      if (candidate.startsWith(prefix)) return true
      // Keycloak also matches the bare origin for a path wildcard:
      // `https://app.example.com/*` matches `https://app.example.com` exactly.
      if (prefix.endsWith('/')) {
        const candidateNoQuery = candidate.split(/[?#]/, 1)[0]
        if (candidateNoQuery === prefix.slice(0, -1)) return true
      }
    }
  }
  return false
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
}): string | undefined {
  const declared = httpUrl(opts.clientUri) ?? httpUrl(opts.launchUrl)
  if (declared) return declared.toString()

  const proxyOrigin = httpUrl(opts.proxyBaseUrl)?.origin
  for (const uri of opts.redirectUris ?? []) {
    const url = redirectOrigin(uri)
    if (!url || url.origin === proxyOrigin || url.pathname.endsWith(DEFAULT_CALLBACK_PATH)) continue
    return url.origin
  }
  return undefined
}
