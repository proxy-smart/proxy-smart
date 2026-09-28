// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { KEYCLOAK_BENCHMARKS as KC } from './content'
import { Topology } from './diagrams'

const count = (n: number) => n.toLocaleString('en-US')

export const Scale: FC = () => {
  const rates = Object.values(KC.throughput)
  const peak = Math.max(...rates.map(t => t.perSecond))
  const pods = KC.topology.zones * KC.topology.podsPerZone
  return (
    <section id="scale">
      <div class="section-label">Scalability</div>
      <h2 class="section-title">Scales with Keycloak, <span class="dim">adds no bottleneck of its own.</span></h2>
      <p class="section-lead">
        The proxy layer is stateless, so it scales out horizontally and inherits Keycloak's proven high-availability setup.
        These are Keycloak's official benchmark figures.
      </p>
      <div class="scale-grid">
        <div class="scale-card">
          <div class="scale-head">
            <div class="scale-big">{count(KC.users.maxTested)}<small class="mono-note">users, max tested</small></div>
            <span class="mono-note">{count(KC.users.regularlyTested)} regularly</span>
          </div>
          <ul class="bars" aria-label="Max tested throughput per second">
            {rates.map(t => (
              <li class="bar-row">
                <div class="bar-meta"><span>{t.label}</span><b>{count(t.perSecond)}<small>/s</small></b></div>
                <div class="bar"><span style={`width: ${(t.perSecond / peak) * 100}%`} /></div>
              </li>
            ))}
          </ul>
        </div>
        <div class="scale-card">
          <div class="section-label">Max tested setup</div>
          <figure class="diagram">
            <Topology />
            <figcaption>
              {count(KC.throughput.passwordLogins.perSecond)} logins and {count(KC.throughput.tokenRefreshes.perSecond)} token refreshes per second
              across {pods} pods. CPU usage scales linearly with request count.
            </figcaption>
          </figure>
        </div>
      </div>
      <div class="sizing">
        {KC.sizing.map(s => <div><b>{s.value}</b>{s.detail}</div>)}
      </div>
      <p class="mono-note spaced">
        Sources: <a href={KC.sourceUrl}>Keycloak benchmarks</a> &middot; <a href={KC.sizingUrl}>CPU and memory sizing</a>
      </p>
    </section>
  )
}
