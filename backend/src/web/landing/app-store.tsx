// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import type { DiscoveredApp } from '@/lib/app-discovery'
import { AppIcon } from '../app-icons'
import { safeUrl } from '../render'
import type { LandingData } from './index'

const AppCard: FC<{ app: DiscoveredApp; tone: number }> = ({ app, tone }) => {
  const name = app.client_name || app.id
  return (
    <a class="app-card" href={safeUrl(app.launch_url) ?? undefined}>
      <div class="app-card-top">
        <AppIcon icon={app.icon} logoUri={app.logoUri} tone={tone} class="app-mono" />
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
        <div class="app-grid">{data.apps.map((app, i) => <AppCard app={app} tone={i} />)}</div>
      </>
    ) : null}
    <p class="app-store-footer">
      Register your own SMART apps via the Admin Dashboard or SMART Dynamic Client Registration (RFC 7591).
    </p>
  </section>
)
