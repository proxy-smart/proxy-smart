// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { config } from '@/config'
import type { DiscoveredApp } from '@/lib/app-discovery'
import { fhirResourceUrlFor, fhirServerStore } from '@/lib/fhir-server-store'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { Document } from './document'
import { PRODUCT } from './product'
import { htmlResponse, safeUrl } from './render'
import { SiteFooter, SiteNav, siteSource, type NavLink, type SiteSource } from './site-chrome'

export interface InstanceServer {
  name: string
  fhirVersion: string
  baseUrl: string
}

export interface InstanceView {
  brand: { name: string; logoUrl: string | null }
  servers: readonly InstanceServer[]
  appCount: number
  showAdmin: boolean
  mcpPath: string
  siteUrl: string
  source: SiteSource
}

export function instanceView(apps: readonly DiscoveredApp[]): InstanceView {
  const brand = getRuntimeBrandConfig()
  const servers = fhirServerStore.getIsInitialized() ? fhirServerStore.getAllServers() : []
  return {
    brand: { name: brand.name, logoUrl: safeUrl(brand.logoUrl) },
    servers: servers.map(s => ({ name: s.name, fhirVersion: s.metadata.fhirVersion, baseUrl: fhirResourceUrlFor(s) })),
    appCount: apps.length,
    showAdmin: config.appStore.showAdminLink,
    mcpPath: config.mcp.path,
    siteUrl: config.siteUrl,
    source: siteSource(),
  }
}

const ServerCard: FC<{ server: InstanceServer }> = ({ server }) => (
  <article class="instance-card">
    <div class="instance-card-head">
      <h3>{server.name}</h3>
      <span class="mono-note">FHIR {server.fhirVersion}</span>
    </div>
    <code class="instance-url">{server.baseUrl}</code>
    <div class="instance-links">
      <a href={`${server.baseUrl}/.well-known/smart-configuration`}>SMART configuration</a>
      <a href={`${server.baseUrl}/metadata`}>Capability statement</a>
    </div>
  </article>
)

const LinkCard: FC<{ href: string; title: string; detail: string }> = ({ href, title, detail }) => (
  <a class="instance-card instance-link" href={href}>
    <h3>{title}</h3>
    <p>{detail}</p>
  </a>
)

export const InstancePage: FC<{ view: InstanceView }> = ({ view }) => {
  const links: NavLink[] = [
    { href: '/apps', label: 'App Store' },
    { href: '/docs', label: 'Docs', strong: true },
  ]
  if (view.showAdmin) links.push({ href: '/webapp/', label: 'Admin' })
  const title = `${view.brand.name} · ${PRODUCT.name}`
  return (
    <Document
      title={title}
      description={`SMART on FHIR authorization for ${view.brand.name}.`}
      stylesheets={['base', 'instance']}
      head={<link rel="canonical" href={`${view.siteUrl}/`} />}
    >
      <SiteNav links={links} />
      <main class="container instance">
        <header class="instance-head">
          {view.brand.logoUrl ? <img class="instance-logo" src={view.brand.logoUrl} alt="" /> : null}
          <div>
            <div class="section-label">SMART on FHIR authorization</div>
            <h1 class="section-title">{view.brand.name}</h1>
            <p class="section-lead">
              This server authorizes SMART apps for the FHIR servers below. Point an app at a server's base URL and it discovers
              the rest from the SMART configuration.
            </p>
          </div>
        </header>

        <section class="instance-section">
          <div class="section-label">FHIR servers</div>
          {view.servers.length === 0 ? (
            <p class="instance-empty">No FHIR servers are registered yet.</p>
          ) : (
            <div class="instance-grid">{view.servers.map(server => <ServerCard server={server} />)}</div>
          )}
        </section>

        <section class="instance-section">
          <div class="section-label">On this server</div>
          <div class="instance-grid">
            <LinkCard href="/apps" title="App Store" detail={`${view.appCount} ${view.appCount === 1 ? 'app' : 'apps'} published`} />
            <LinkCard href="/docs" title="Documentation" detail="Setup, configuration and the SMART implementation status" />
            <LinkCard href={view.mcpPath} title="MCP endpoint" detail={`Streamable HTTP at ${view.mcpPath}, OAuth protected`} />
            <LinkCard href="/health" title="Status" detail="Liveness and subsystem health" />
            <LinkCard href="/source" title="Source" detail={`The exact source of v${view.source.version.split('+')[0]}`} />
          </div>
        </section>
      </main>
      <div class="container"><SiteFooter source={view.source} /></div>
    </Document>
  )
}

export function instanceResponse(apps: readonly DiscoveredApp[]): Response {
  return htmlResponse(<InstancePage view={instanceView(apps)} />)
}
