// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { config } from '@/config'
import type { DiscoveredApp } from '@/lib/app-discovery'
import { fhirServerStore } from '@/lib/fhir-server-store'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { buildSourceOffer } from '@/lib/source-offer'
import { Document, JsonLd } from '../document'
import { htmlResponse } from '../render'
import { PRODUCT } from './content'
import { Nav, Footer } from './chrome'
import { Hero } from './hero'
import { Architecture } from './architecture'
import { Pipeline } from './pipeline'
import { AppStore } from './app-store'
import { Scale } from './scale'
import { QuickStart } from './quick-start'
import { Faq, faqJsonLd } from './faq'

export interface LandingData {
  baseUrl: string
  mcpPath: string
  apps: readonly DiscoveredApp[]
  servers: readonly { name: string; fhirVersion: string }[]
  brand: { name: string; website: string; logoUrl: string | null }
  source: { version: string; repositoryUrl: string; sourceUrl: string }
}

export function loadLandingData(apps: readonly DiscoveredApp[]): LandingData {
  const brand = getRuntimeBrandConfig()
  const offer = buildSourceOffer()
  const servers = fhirServerStore.getIsInitialized() ? fhirServerStore.getAllServers() : []
  return {
    baseUrl: config.baseUrl,
    mcpPath: config.mcp.path,
    apps,
    servers: servers.map(s => ({ name: s.name, fhirVersion: s.metadata.fhirVersion })),
    brand: { name: brand.name, website: brand.website, logoUrl: brand.logoUrl },
    source: { version: offer.version, repositoryUrl: offer.repositoryUrl, sourceUrl: offer.sourceUrl },
  }
}

function structuredData(data: LandingData): unknown[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: data.brand.name,
      url: data.brand.website,
      logo: data.brand.logoUrl ?? `${data.baseUrl}/proxy-smart.svg`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: PRODUCT.name,
      description: PRODUCT.tagline,
      applicationCategory: 'HealthApplication',
      operatingSystem: 'Linux, Docker',
      url: `${data.baseUrl}/`,
      downloadUrl: data.source.repositoryUrl,
      softwareVersion: data.source.version,
      author: { '@type': 'Organization', ...PRODUCT.author },
      license: 'https://opensource.org/licenses/AGPL-3.0',
      offers: [{ '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Open source under AGPL-3.0' }],
    },
    faqJsonLd(data),
  ]
}

const SocialMeta: FC<{ data: LandingData }> = ({ data }) => {
  const title = `${PRODUCT.name}: SMART on FHIR Proxy`
  const image = `${data.baseUrl}/proxy-smart.svg`
  return (
    <>
      <meta name="author" content={PRODUCT.author.name} />
      <link rel="canonical" href={`${data.baseUrl}/`} />
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={PRODUCT.tagline} />
      <meta property="og:url" content={`${data.baseUrl}/`} />
      <meta property="og:site_name" content={PRODUCT.name} />
      <meta property="og:image" content={image} />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={PRODUCT.tagline} />
      <meta name="twitter:image" content={image} />
      <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable product description" />
      {structuredData(data).map(node => <JsonLd data={node} />)}
    </>
  )
}

export const LandingPage: FC<{ data: LandingData }> = ({ data }) => (
  <Document
    title={`${PRODUCT.name}: SMART on FHIR Proxy | Open-Source Healthcare Auth`}
    description={`${PRODUCT.tagline} No PHI stored. Docker-ready.`}
    stylesheets={['base', 'landing']}
    head={<SocialMeta data={data} />}
  >
    <div class="noise" />
    <Nav data={data} />
    <Hero data={data} />
    <div class="container">
      <Architecture data={data} />
      <Pipeline />
      <AppStore data={data} />
      <div class="statement">
        <div class="statement-glow" />
        <p>
          The hardest part of building a healthcare app is the{' '}
          <span class="highlight">authentication, authorization and interoperability</span>{' '}
          around the clinical logic. We handle that part.
        </p>
      </div>
      <Scale />
      <QuickStart data={data} />
      <Faq data={data} />
      <Footer data={data} />
    </div>
  </Document>
)

export function landingResponse(apps: readonly DiscoveredApp[]): Response {
  return htmlResponse(<LandingPage data={loadLandingData(apps)} />)
}
