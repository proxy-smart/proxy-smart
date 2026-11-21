// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** What every self-onboarded client passes before Keycloak holds it, whether it registered (RFC 7591) or is named by its metadata document. */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { checkExternalUrl } from '@proxy-smart/auth'
import { logger } from '@/lib/logger'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { isJwks } from '@/lib/client-jwks'
import { ensureScopeMappers, SMART_SCOPE_MAPPERS } from '@/lib/smart-scope-mappers'
import { assignResourceIndicatorsScope, assignStandardOidcScopes } from '@/lib/smart-client-enrichment'
import {
  KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  STANDARD_OIDC_DEFAULT_SCOPES,
  STANDARD_OIDC_OPTIONAL_SCOPES,
} from '@/lib/oauth-scopes'
import type { ClientRegistrationRequestType, ClientRegistrationSettingsType } from '@/schemas'
import {
  classifyRegistration,
  redirectUriMatchesPatterns,
  redirectUriRejection,
  usesAuthorizationCode,
  type DcrClientKind,
} from './dcr-client'

export type RegistrationVetting =
  | { ok: true; kind: DcrClientKind; authorizationCode: boolean; grantedScope?: string }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; error_description: string }

const refuse = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', error_description: string): RegistrationVetting =>
  ({ ok: false, error, error_description })

/** The registration policy an operator set; whether registration is open at all is the caller's question. */
export async function vetRegistration(
  body: ClientRegistrationRequestType,
  settings: ClientRegistrationSettingsType,
): Promise<RegistrationVetting> {
  const kind = classifyRegistration(body)
  const authorizationCode = usesAuthorizationCode(body, kind)

  if (authorizationCode && body.redirect_uris.length === 0) return refuse('invalid_redirect_uri', 'At least one redirect_uri is required')
  if (body.redirect_uris.length > settings.maxRedirectUris) {
    return refuse('invalid_redirect_uri', `Maximum ${settings.maxRedirectUris} redirect URIs allowed`)
  }
  const redirectRejection = redirectUriRejection(body.redirect_uris, settings.requireHttps)
  if (redirectRejection) return refuse('invalid_redirect_uri', redirectRejection)
  if (body.redirect_uris.some((uri) => !redirectUriMatchesPatterns(uri, settings.allowedRedirectUriPatterns))) {
    return refuse('invalid_redirect_uri', 'One or more redirect URIs do not match allowed patterns')
  }

  if (settings.requireTermsOfService && !body.tos_uri) return refuse('invalid_client_metadata', 'Terms of service URI is required')
  if (settings.requirePrivacyPolicy && !body.policy_uri) return refuse('invalid_client_metadata', 'Privacy policy URI is required')

  // jwks_uri is fetched server-side at token time; refuse internal hosts before it is stored.
  if (body.jwks_uri) {
    const jwksUriCheck = await checkExternalUrl(body.jwks_uri, outboundUrlPolicy)
    if (!jwksUriCheck.valid) {
      logger.admin.warn('Rejected client with SSRF-suspect jwks_uri', { jwksUri: body.jwks_uri, reason: jwksUriCheck.reason })
      return refuse('invalid_client_metadata', `jwks_uri rejected: ${jwksUriCheck.reason}`)
    }
  }
  if (body.jwks && !isJwks(body.jwks)) return refuse('invalid_client_metadata', 'jwks must be a JWK Set with a keys array')

  if (kind === 'public' && !settings.allowPublicClients) return refuse('invalid_client_metadata', 'Public clients are not allowed')
  if (kind === 'confidential' && !settings.allowConfidentialClients) return refuse('invalid_client_metadata', 'Confidential clients are not allowed')
  if (kind === 'backend-service' && !settings.allowBackendServices) return refuse('invalid_client_metadata', 'Backend service clients are not allowed')

  // RFC 7591 §2: the server MAY grant fewer scopes than requested, and registers a default set when none is named.
  const requested = body.scope?.trim() ? body.scope.trim().split(/\s+/) : settings.allowedScopes
  const grantedScope = requested.filter((scope) => settings.allowedScopes.includes(scope)).join(' ') || undefined

  return { ok: true, kind, authorizationCode, grantedScope }
}

/** Default OIDC and resource-indicator scopes, and any granted extras as OPTIONAL so the user must ask for them. */
export async function configureClientScopes(
  admin: KcAdminClient,
  id: string,
  clientId: string,
  grantedScope: string | undefined,
): Promise<void> {
  try {
    const allClientScopes = await admin.clientScopes.find()
    await assignStandardOidcScopes(admin, id, clientId, allClientScopes)
    // RFC 8707: without it, token exchange with a resource param fails with invalid_target.
    await assignResourceIndicatorsScope(admin, id, clientId, allClientScopes)
    if (!grantedScope) return

    const baseline = new Set<string>([
      ...KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
      ...STANDARD_OIDC_DEFAULT_SCOPES,
      ...STANDARD_OIDC_OPTIONAL_SCOPES,
    ])
    for (const scopeName of grantedScope.split(' ')) {
      if (!scopeName || baseline.has(scopeName)) continue
      const matchingScope = allClientScopes.find((scope) => scope.name === scopeName)
      if (!matchingScope?.id) {
        logger.admin.debug('Scope not found in Keycloak, skipping', { clientId, scopeName })
        continue
      }
      try {
        await admin.clients.addOptionalClientScope({ id, clientScopeId: matchingScope.id })
        if (SMART_SCOPE_MAPPERS[scopeName]) await ensureScopeMappers(admin, matchingScope.id, scopeName)
      } catch (scopeError) {
        logger.admin.warn('Failed to assign scope to client', { clientId, scopeName, error: scopeError })
      }
    }
  } catch (scopeError) {
    logger.admin.warn('Failed to configure client scopes', { clientId, error: scopeError })
  }
}
