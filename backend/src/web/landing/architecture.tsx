// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { PRODUCT, PROXY_HANDLES, YOU_PROVIDE, type Listed } from './content'
import { ArchitectureTall, ArchitectureWide } from './diagrams'
import { Icon } from './icons'
import type { LandingData } from './index'

function fhirSummary(servers: LandingData['servers']): string {
  if (servers.length === 0) return 'ANY FHIR R4 / R4B'
  const versions = [...new Set(servers.map(s => s.fhirVersion).filter(Boolean))]
  return [`${servers.length} CONNECTED`, versions.join(' / ')].filter(Boolean).join(' · ')
}

const SplitCard: FC<{ label: string; items: readonly Listed[]; accent?: boolean }> = ({ label, items, accent }) => (
  <div class={accent ? 'split-card accent' : 'split-card'}>
    <div class="section-label flush">{label}</div>
    <ul>
      {items.map(item => (
        <li>
          <Icon name={item.icon} />
          <span>{item.title}<small>{item.detail}</small></span>
        </li>
      ))}
    </ul>
  </div>
)

export const Architecture: FC<{ data: LandingData }> = ({ data }) => {
  const summary = fhirSummary(data.servers)
  return (
    <section id="architecture">
      <div class="section-label">Architecture</div>
      <h2 class="section-title">One proxy between your apps <span class="dim">and your clinical data.</span></h2>
      <p class="section-lead">
        {PRODUCT.name} sits between SMART apps and FHIR servers and handles authentication and authorization. Requests pass
        through to your existing servers while the proxy manages OAuth flows and access control.{' '}
        <strong>PostgreSQL only stores users and configuration.</strong>
      </p>
      <figure class="diagram">
        <ArchitectureWide fhirSummary={summary} />
        <ArchitectureTall fhirSummary={summary} />
        <figcaption>
          <span class="legend request"><span>Client requests</span></span>
          <span class="legend data"><span>Clinical data, passed through</span></span>
          <span class="legend identity"><span>Identity and tokens</span></span>
        </figcaption>
      </figure>
      <div class="split">
        <SplitCard label="You provide" items={YOU_PROVIDE} />
        <SplitCard label={`${PRODUCT.name} handles`} items={PROXY_HANDLES} accent />
      </div>
    </section>
  )
}
