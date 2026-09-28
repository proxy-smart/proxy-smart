// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import type { DiscoveredApp } from '@/lib/app-discovery'
import { safeUrl } from '../render'
import type { LandingData } from './index'

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

const AppCard: FC<{ app: DiscoveredApp }> = ({ app }) => {
  const logo = safeUrl(app.logoUri)
  const name = app.client_name || app.id
  return (
    <a class="app-card" href={safeUrl(app.launch_url) ?? undefined}>
      <div class="app-card-top">
        <span class="app-mono">{logo ? <img src={logo} alt="" loading="lazy" /> : initials(name)}</span>
        <div>
          <div class="app-name">{name}</div>
          <div class="mono-note">{app.category}</div>
        </div>
      </div>
      <p class="app-desc">{app.description}</p>
      <span class="app-launch">Launch &rarr;</span>
    </a>
  )
}

export const AppStore: FC<{ data: LandingData }> = ({ data }) => (
  <section id="appstore">
    <div class="section-label">App Store</div>
    <div class="section-head">
      <p class="section-lead flush">
        Register, manage, and launch SMART on FHIR apps through a single admin interface. Every app gets OAuth 2.0 + PKCE,
        scope-based access control, and FHIR server routing out of the box.
      </p>
      <a href="/apps" class="btn">Browse the App Store &rarr;</a>
    </div>
    {data.apps.length > 0 ? (
      <>
        <div class="mono-note">
          {data.apps.length} {data.apps.length === 1 ? 'app' : 'apps'} published on this deployment
        </div>
        <div class="app-grid">{data.apps.map(app => <AppCard app={app} />)}</div>
      </>
    ) : null}
    <p class="app-store-footer">
      Register your own SMART apps via the Admin Dashboard or SMART Dynamic Client Registration (RFC 7591).
    </p>
  </section>
)
