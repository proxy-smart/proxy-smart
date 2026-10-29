// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Keycloak answers an incomplete IdP config with 500 `unknown_error`, so the proxy validates first.

const OIDC_REQUIRED = ['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl'] as const

const OIDC_FAMILY = new Set(['oidc', 'keycloak-oidc', 'oauth2'])

const SECRET_AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic', 'client_secret_jwt'])

// An unset clientAuthMethod still needs a secret: Keycloak defaults to `client_secret_post`.
function oidcRequired(config: Record<string, unknown> | undefined): readonly string[] {
  const method = config?.clientAuthMethod
  const usesSecret =
    typeof method === 'string' && method !== '' ? SECRET_AUTH_METHODS.has(method) : true
  return usesSecret ? OIDC_REQUIRED : OIDC_REQUIRED.filter((key) => key !== 'clientSecret')
}

// Explicit list so an unknown providerId is left to Keycloak rather than under-checked.
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
  ...Object.fromEntries(SOCIAL_PROVIDERS.map((id) => [id, ['clientId', 'clientSecret']])),
}

/** The keys `providerId` needs, or an empty list when the type is not known here. */
export function requiredConfigFor(
  providerId: string,
  config?: Record<string, unknown>,
): readonly string[] {
  if (OIDC_FAMILY.has(providerId)) return oidcRequired(config)
  return REQUIRED_CONFIG[providerId] ?? []
}

/** Required keys that are absent or blank (Keycloak treats `""` as missing). */
export function missingConfigKeys(
  providerId: string,
  config: Record<string, unknown> | undefined,
): string[] {
  return requiredConfigFor(providerId, config).filter((key) => {
    const value = config?.[key]
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  })
}
