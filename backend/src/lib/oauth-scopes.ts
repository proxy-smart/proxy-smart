// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// The standard OIDC scopes this deployment advertises, challenges for, and grants. One list so
// the three cannot drift; `dcr-standard-scopes.test.ts` pins that. Per-app SMART scopes live in
// `packages/auth/src/smart-scopes.ts`.

/** Always attached and always in the token. These are the scopes the 401 challenge names. */
export const STANDARD_OIDC_DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const

/** Attached to the client but only issued when explicitly requested. Not advertised. */
export const STANDARD_OIDC_OPTIONAL_SCOPES = ['offline_access'] as const

/** A backend service authenticates as itself, so `email` has nobody to describe. */
export const BACKEND_SERVICE_DEFAULT_SCOPES = ['openid', 'profile'] as const

/** Keycloak builtins, silent (`include.in.token.scope=false`). Without them RBAC cannot be enforced. */
export const KEYCLOAK_BUILTIN_DEFAULT_SCOPES = ['roles', 'web-origins', 'acr'] as const

/**
 * RFC 9728 `scopes_supported`. Defaults only: anything added here MUST be grantable to any user
 * who can log in. `offline_access` is excluded because Keycloak gates it on a realm role and
 * fails the whole code exchange without it, while authorization_code already returns a
 * session-bound refresh token.
 */
export const MCP_SCOPES_SUPPORTED: readonly string[] = [...STANDARD_OIDC_DEFAULT_SCOPES]

/** The `scope` in the `WWW-Authenticate` challenge on a 401 from the MCP endpoint. */
export const MCP_SCOPE_CHALLENGE: string = STANDARD_OIDC_DEFAULT_SCOPES.join(' ')
