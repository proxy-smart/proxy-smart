// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Config keys a provider cannot work without. Keycloak answers an incomplete one with 500
 * `unknown_error`, so the proxy refuses first with a 400 that names them.
 */

/** Keycloak's own generic OIDC/OAuth2 brokers. `clientSecret` is conditional — see below. */
const OIDC_REQUIRED = ['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl'] as const

const OIDC_FAMILY = new Set(['oidc', 'keycloak-oidc', 'oauth2'])

/** The client-authentication methods that actually carry a shared secret. */
const SECRET_AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic', 'client_secret_jwt'])

/**
 * A shared secret is required only by the methods that use one. `private_key_jwt` signs with a
 * key pair and `none` relies on PKCE, so demanding one there rejects the stronger configurations.
 * An unset method still needs it: Keycloak defaults to `client_secret_post`.
 */
function oidcRequired(config: Record<string, unknown> | undefined): readonly string[] {
  const method = config?.clientAuthMethod
  const usesSecret =
    typeof method === 'string' && method !== '' ? SECRET_AUTH_METHODS.has(method) : true
  return usesSecret ? OIDC_REQUIRED : OIDC_REQUIRED.filter((key) => key !== 'clientSecret')
}

/**
 * Social brokers ship their endpoints in the provider factory, so a caller only
 * supplies credentials. Listed explicitly rather than matched by a fallback, so an
 * unknown providerId is left to Keycloak instead of being silently under-checked.
 */
const SOCIAL_PROVIDERS = [
  'google', 'github', 'facebook', 'microsoft', 'gitlab', 'bitbucket',
  'linkedin', 'linkedin-openid-connect', 'twitter', 'instagram',
  'paypal', 'stackoverflow', 'openshift-v3', 'openshift-v4',
] as const

const SOCIAL_PROVIDER_IDS: ReadonlySet<string> = new Set(SOCIAL_PROVIDERS)

/** Providers whose config Keycloak models as an OAuth2 client, and so carries a client secret. */
export function isOAuth2Broker(providerId: string): boolean {
  return OIDC_FAMILY.has(providerId) || SOCIAL_PROVIDER_IDS.has(providerId)
}

const REQUIRED_CONFIG: Record<string, readonly string[]> = {
  saml: ['singleSignOnServiceUrl'],
  // Social brokers have no clientAuthMethod: they always authenticate with a secret.
  ...Object.fromEntries(SOCIAL_PROVIDERS.map((id) => [id, ['clientId', 'clientSecret']])),
}

/**
 * The keys `providerId` needs, or an empty list when the type is not known here.
 *
 * `config` is read only by the OIDC family, whose secret requirement depends on the
 * `clientAuthMethod` in it.
 */
export function requiredConfigFor(
  providerId: string,
  config?: Record<string, unknown>,
): readonly string[] {
  if (OIDC_FAMILY.has(providerId)) return oidcRequired(config)
  return REQUIRED_CONFIG[providerId] ?? []
}

/**
 * Which required keys are absent or blank.
 *
 * Blank counts as absent: Keycloak treats `clientId: ""` exactly as it treats a
 * missing one, and a form that submits empty inputs is the common way to get here.
 */
export function missingConfigKeys(
  providerId: string,
  config: Record<string, unknown> | undefined,
): string[] {
  return requiredConfigFor(providerId, config).filter((key) => {
    const value = config?.[key]
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  })
}
