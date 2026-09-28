// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { PRODUCT } from './content'
import type { LandingData } from './index'

type Dot = 'green' | 'blue' | 'purple'

export const Hero: FC<{ data: LandingData }> = ({ data }) => {
  const badges: readonly { href: string; dot: Dot; label: string }[] = [
    { href: PRODUCT.smartSpecUrl, dot: 'green', label: 'SMART App Launch 2.2.0' },
    { href: PRODUCT.fhirSpecUrl, dot: 'blue', label: 'FHIR R4 / R4B' },
    { href: `${data.source.repositoryUrl}/${PRODUCT.complianceWorkflow}`, dot: 'green', label: 'Inferno tested in CI' },
    { href: '/source', dot: 'purple', label: PRODUCT.licenseLabel },
  ]
  return (
    <div class="hero">
      <div class="hero-grid" />
      <div class="hero-glow" />
      <div class="hero-content">
        <div class="hero-eyebrow fade-in">
          <span class="hero-eyebrow-line" />
          <span>Open Source</span>
          <span class="hero-eyebrow-line" />
        </div>
        <h1>
          <span class="fade-in-d1">{PRODUCT.name}</span><br />
          <span class="fade-in-d2 dim">Healthcare Auth,</span><br />
          <span class="fade-in-d2 dim">Solved.</span>
        </h1>
        <p class="hero-sub fade-in-d3">
          A stateless proxy that adds OAuth 2.0 and SMART App Launch authorization to the FHIR servers you
          already run. <strong>Your clinical data stays exactly where it is.</strong>
        </p>
        <div class="hero-badges fade-in-d3">
          {badges.map(b => (
            <a class="hero-badge" href={b.href}><span class={`badge-dot ${b.dot}`} />{b.label}</a>
          ))}
        </div>
        <div class="hero-actions fade-in-d4">
          <a href="#quickstart" class="btn">Get Started &rarr;</a>
          <a href="/apps" class="btn">View App Store</a>
        </div>
      </div>
      <div class="scroll-indicator fade-in-d5">
        <span>Scroll</span>
        <div class="scroll-indicator-line" />
      </div>
    </div>
  )
}
