// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Logout is proxied server-side so Keycloak's logout and logout-confirm pages are never exposed.

import { Elysia, t } from 'elysia'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { getClientHomeUrl, getRegisteredRedirectUris } from '@/lib/smart-client-config-cache'
import { resolveClientBrandColors } from '@/lib/org-branding'
import { brandAccent } from '@/lib/brand-color'
import { smartStore, keycloakAdapter } from '../smart-proxy-setup'
import { kcUnavailablePage } from '@/web/status-pages'
import { resolvePostLogoutUri } from '@proxy-smart/auth'
import { LoginQuery, LogoutQuery, PublicIdentityProvidersResponse } from '@/schemas'
import { isKeycloakReachable } from './shared'
import { loginIdentityProviders } from '@/lib/idp-login-options'

/** A JWT-shaped id_token_hint. Anything else is not worth a Keycloak round trip. */
function isUsableIdTokenHint(hint: unknown): hint is string {
  return typeof hint === 'string' && hint.split('.').length === 3 && hint.length > 50
}

export const loginRoutes = new Elysia({ tags: ['authentication'] })

  // Public by necessity (rendered before sign-in); discloses only a colour, and only for a known client_id.
  .get('/login-brand.css', async ({ query, set }) => {
    set.headers['content-type'] = 'text/css; charset=utf-8'
    set.headers['Cache-Control'] = 'public, max-age=60'

    // Re-validated at the sink that writes into a stylesheet, independent of the resolver.
    const accent = brandAccent(await resolveClientBrandColors(query.client_id))
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

  // Only a registered home is ever a target.
  .get('/return', async ({ query, redirect }) => {
    const home = query.client_id ? await getClientHomeUrl(query.client_id) : undefined
    return redirect(home ?? config.siteUrl, 302)
  }, {
    query: t.Object({
      client_id: t.Optional(t.String({ description: 'Client whose login failed, as remembered by the login theme.' })),
    }),
    detail: {
      summary: 'Return to Application',
      description: "Redirects to the client's registered home URL (or redirect-URI origin), else the site root. Never to an unregistered address.",
      tags: ['authentication'],
    },
  })

  .get('/login', async ({ query, redirect }) => {
    if (!await isKeycloakReachable()) return kcUnavailablePage()

    const url = new URL(keycloakAdapter.getAuthorizationUrl())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', query.client_id || config.keycloak.adminUiClientId)
    url.searchParams.set('redirect_uri', query.redirect_uri || `${config.baseUrl}/`)
    url.searchParams.set('scope', query.scope || 'openid profile email')
    url.searchParams.set('state', query.state || crypto.randomUUID())

    Object.entries(query).forEach(([k, v]) => {
      if (!['state', 'client_id', 'redirect_uri', 'scope'].includes(k)) {
        url.searchParams.set(k, v)
      }
    })
    return redirect(url.href)
  }, {
    query: LoginQuery,
    detail: { summary: 'Login Page Redirect', description: 'Simplified login endpoint that redirects to Keycloak with sensible defaults', tags: ['authentication'] }
  })

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

    // The browser holds the Keycloak cookie, so let Keycloak end it; the hint skips its confirm page.
    if (!ended) {
      const endSession = new URL(keycloakAdapter.getLogoutUrl())
      if (isUsableIdTokenHint(query.id_token_hint)) {
        endSession.searchParams.set('id_token_hint', query.id_token_hint)
      }
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

  .get('/identity-providers', () => loginIdentityProviders.list(), {
    response: { 200: PublicIdentityProvidersResponse },
    detail: {
      summary: 'Get Public Identity Providers',
      description: 'Identity providers offered as sign-in buttons: enabled, not link-only and not hidden on the login page, in the realm GUI order. Carries no provider configuration. Empty when Keycloak cannot be asked.',
      tags: ['authentication'],
    },
  })
