// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Sign-in, sign-out, and what the Keycloak login page needs from the proxy.
 *
 * Logout is a server-side proxy rather than a browser redirect, so Keycloak's
 * logout and logout-confirm pages are never exposed through the reverse proxy.
 */

import { Elysia, t } from 'elysia'
import fetch from 'cross-fetch'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { getRegisteredRedirectUris } from '@/lib/smart-client-config-cache'
import { resolveClientBrandColors } from '@/lib/org-branding'
import { safeCssColor } from '@/lib/brand-color'
import { smartStore, keycloakAdapter } from '../smart-proxy-setup'
import { kcUnavailablePage } from '../smart-templates'
import { resolvePostLogoutUri } from '@proxy-smart/auth'
import { LoginQuery, LogoutQuery, PublicIdentityProvidersResponse } from '@/schemas'
import { isKeycloakReachable } from './shared'

/** A JWT-shaped id_token_hint. Anything else is not worth a Keycloak round trip. */
function isUsableIdTokenHint(hint: unknown): hint is string {
  return typeof hint === 'string' && hint.split('.').length === 3 && hint.length > 50
}

export const loginRoutes = new Elysia({ tags: ['authentication'] })

  // ── Login page brand accent (Keycloak login theme) ────────────────────
  // The login theme is static CSS served by Keycloak, so it cannot resolve an
  // organization itself. Its `brand-accent.js` adds a render-blocking <link> to this
  // endpoint with the client_id already on the login URL, and everything built on
  // --ps-accent retints before first paint.
  //
  // Public by necessity: this is rendered before anyone has authenticated. It discloses
  // only a colour, and only to someone who already knows a client_id.
  .get('/login-brand.css', async ({ query, set }) => {
    set.headers['content-type'] = 'text/css; charset=utf-8'
    // Brief: a colour change should reach the login page without a redeploy, but the
    // stylesheet is render-blocking on every login attempt.
    set.headers['Cache-Control'] = 'public, max-age=60'

    const { primaryColor, accentColor } = await resolveClientBrandColors(query.client_id)
    // The login page tints from one accent. primaryColor is the organization's actual
    // brand colour; accentColor only overrides it when set explicitly.
    //
    // Re-validated here even though the resolver already did: this is the sink that writes
    // into a stylesheet, and it should not depend on a caller upstream having been careful.
    const accent = safeCssColor(accentColor) ?? safeCssColor(primaryColor)
    if (!accent) return ''
    return `:root{--brand-accent:${accent}}
`
  }, {
    query: t.Object({
      client_id: t.Optional(t.String({ description: 'Launching client, as present on the Keycloak login URL.' })),
    }),
    detail: {
      summary: 'Login Brand Accent (CSS)',
      description: 'Per-organization accent colour for the Keycloak login theme, as a CSS custom property. Empty when no colour is configured, so the theme default applies.',
      tags: ['authentication'],
    },
  })

  // ── Login redirect ────────────────────────────────────────────────────
  .get('/login', async ({ query, redirect }) => {
    if (!await isKeycloakReachable()) return kcUnavailablePage()

    const url = new URL(keycloakAdapter.getAuthorizationUrl())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', query.client_id || 'admin-ui')
    url.searchParams.set('redirect_uri', query.redirect_uri || `${config.baseUrl}/`)
    url.searchParams.set('scope', query.scope || 'openid profile email')
    url.searchParams.set('state', query.state || crypto.randomUUID())

    Object.entries(query).forEach(([k, v]) => {
      if (!['state', 'client_id', 'redirect_uri', 'scope'].includes(k)) {
        url.searchParams.set(k, v as string)
      }
    })
    return redirect(url.href)
  }, {
    query: LoginQuery,
    detail: { summary: 'Login Page Redirect', description: 'Simplified login endpoint that redirects to Keycloak with sensible defaults', tags: ['authentication'] }
  })

  // ── Logout ────────────────────────────────────────────────────────────
  .get('/logout', async ({ query, redirect }) => {
    const session = query.state ? smartStore.get(query.state) : undefined
    let ended = false

    // A failed launch has no id_token_hint, so the session would otherwise survive.
    if (session?.userSub) {
      try {
        const admin = await getAdminClient()
        await admin?.users.logout({ id: session.userSub })
        ended = true
        logger.auth.info('Ended Keycloak session for a failed launch', { clientId: session.clientId })
      } catch (error) {
        logger.auth.error('Admin logout failed', { error })
      }
    }

    const logoutClientId = query.client_id || session?.clientId
    const registeredForLogout = !session?.clientRedirectUri && query.post_logout_redirect_uri && logoutClientId
      ? await getRegisteredRedirectUris(logoutClientId).catch(() => [])
      : []

    const postLogoutUri = resolvePostLogoutUri({
      baseUrl: config.baseUrl,
      sessionRedirectUri: session?.clientRedirectUri,
      requested: query.post_logout_redirect_uri,
      registered: registeredForLogout,
    })

    if (isUsableIdTokenHint(query.id_token_hint)) {
      try {
        const kcLogoutUrl = new URL(
          `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/logout`,
        )
        kcLogoutUrl.searchParams.set('id_token_hint', query.id_token_hint)
        kcLogoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutUri)
        if (query.client_id) kcLogoutUrl.searchParams.set('client_id', query.client_id)

        const resp = await fetch(kcLogoutUrl.href, { redirect: 'manual' })

        if (resp.status >= 200 && resp.status < 400) {
          ended = true
          logger.auth.debug('Keycloak session ended via server-side logout')
        } else {
          logger.auth.warn('Keycloak logout returned unexpected status', { status: resp.status })
        }
      } catch (error) {
        logger.auth.error('Server-side Keycloak logout failed', { error })
      }
    }

    // The server could not end it, but the browser holds the Keycloak cookie: let Keycloak do it.
    if (!ended) {
      const endSession = new URL(keycloakAdapter.getLogoutUrl())
      if (logoutClientId && postLogoutUri !== config.baseUrl) {
        endSession.searchParams.set('client_id', logoutClientId)
        endSession.searchParams.set('post_logout_redirect_uri', postLogoutUri)
      }
      return redirect(endSession.href)
    }

    return redirect(postLogoutUri)
  }, {
    query: LogoutQuery,
    detail: { summary: 'Logout Endpoint', description: 'Proxies logout to Keycloak server-side and redirects to post_logout_redirect_uri', tags: ['authentication'] }
  })

  // ── Public identity providers ─────────────────────────────────────────
  .get('/identity-providers', async () => {
    try {
      const realmUrl = `${config.keycloak.publicUrl}/realms/${config.keycloak.realm}`
      const response = await fetch(realmUrl)
      if (!response.ok) throw new Error(`Failed: ${response.status}`)
      const realmInfo = await response.json()
      const identityProviders = realmInfo.identityProviders || []
      return identityProviders
        .filter((p: { enabled?: boolean }) => p.enabled !== false)
        .map((p: { alias?: string; providerId?: string; displayName?: string; enabled?: boolean }) => ({
          alias: p.alias ?? '', providerId: p.providerId ?? '',
          displayName: p.displayName ?? p.alias ?? '', enabled: p.enabled ?? false,
        }))
    } catch (error) {
      logger.auth.error('Failed to fetch public identity providers', { error })
      return []
    }
  }, {
    response: { 200: PublicIdentityProvidersResponse },
    detail: { summary: 'Get Public Identity Providers', description: 'Get list of enabled identity providers for login page', tags: ['authentication'] }
  })
