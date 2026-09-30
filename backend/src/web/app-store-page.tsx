// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { config } from '@/config'
import type { DiscoveredApp } from '@/lib/app-discovery'
import { AppIcon } from './app-icons'
import { Document } from './document'
import { PRODUCT } from './product'
import { htmlResponse, safeUrl } from './render'
import { SiteFooter, SiteNav, siteSource, type NavLink, type SiteSource } from './site-chrome'

const TILE_SIZES = {
  sm: { label: 'S', name: 'Small tiles', perPage: 24 },
  md: { label: 'M', name: 'Medium tiles', perPage: 18 },
  lg: { label: 'L', name: 'Large tiles', perPage: 12 },
} as const

export type TileSize = keyof typeof TILE_SIZES

const SIZE_ORDER: readonly TileSize[] = ['sm', 'md', 'lg']
const DEFAULT_SIZE: TileSize = 'md'

function isTileSize(value: unknown): value is TileSize {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TILE_SIZES, value)
}

export interface AppStoreQuery {
  size?: string
  page?: string
}

export interface AppStoreView {
  apps: readonly DiscoveredApp[]
  offset: number
  total: number
  size: TileSize
  page: number
  pages: number
  showAdmin: boolean
  siteUrl: string
  source: SiteSource
}

export function appStoreView(all: readonly DiscoveredApp[], query: AppStoreQuery = {}): AppStoreView {
  const size = isTileSize(query.size) ? query.size : DEFAULT_SIZE
  const { perPage } = TILE_SIZES[size]
  const pages = Math.max(1, Math.ceil(all.length / perPage))
  const requested = Number.parseInt(query.page ?? '', 10)
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pages) : 1
  const offset = (page - 1) * perPage
  return {
    apps: all.slice(offset, offset + perPage),
    offset,
    total: all.length,
    size,
    page,
    pages,
    showAdmin: config.appStore.showAdminLink,
    siteUrl: config.siteUrl,
    source: siteSource(),
  }
}

function storeHref(size: TileSize, page: number): string {
  const params = new URLSearchParams()
  if (size !== DEFAULT_SIZE) params.set('size', size)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `/apps?${qs}` : '/apps'
}

const Tile: FC<{ app: DiscoveredApp; tone: number }> = ({ app, tone }) => {
  const name = app.client_name || app.id
  return (
    <a class="tile" href={safeUrl(app.launch_url) ?? undefined} title={app.description || name}>
      <AppIcon icon={app.icon} logoUri={app.logoUri} tone={tone} />
      <span class="label">{name}</span>
    </a>
  )
}

const Pagination: FC<{ view: AppStoreView }> = ({ view }) => {
  if (view.pages <= 1) return null
  const numbers = Array.from({ length: view.pages }, (_, i) => i + 1)
  return (
    <nav class="pagination" aria-label="Pages">
      {view.page > 1 ? <a href={storeHref(view.size, view.page - 1)}>&lsaquo; Prev</a> : <span class="disabled">&lsaquo; Prev</span>}
      {numbers.map(n => (
        <a href={storeHref(view.size, n)} class={n === view.page ? 'active' : undefined} aria-current={n === view.page ? 'page' : undefined}>{n}</a>
      ))}
      {view.page < view.pages ? <a href={storeHref(view.size, view.page + 1)}>Next &rsaquo;</a> : <span class="disabled">Next &rsaquo;</span>}
    </nav>
  )
}

export const AppStorePage: FC<{ view: AppStoreView }> = ({ view }) => {
  const links: NavLink[] = [
    { href: '/', label: 'Home' },
    { href: '/docs', label: 'Docs', strong: true },
    { href: view.source.repositoryUrl, label: 'GitHub' },
  ]
  if (view.showAdmin) links.push({ href: '/webapp/', label: 'Admin' })
  return (
    <Document
      title={`Apps · ${PRODUCT.name}`}
      description={`SMART on FHIR apps available on this ${PRODUCT.name} deployment.`}
      stylesheets={['base', 'app-store']}
      head={<link rel="canonical" href={`${view.siteUrl}${storeHref(view.size, view.page)}`} />}
    >
      <SiteNav links={links} />
      <main class="container store">
        <div class="store-toolbar">
          <div>
            <div class="section-label">App Store</div>
            <h1 class="section-title">Applications <span class="dim">available on this platform.</span></h1>
          </div>
          <div class="size-toggle" role="group" aria-label="Tile size">
            {SIZE_ORDER.map(size => (
              <a href={storeHref(size, 1)} class={size === view.size ? 'active' : undefined} aria-current={size === view.size ? 'true' : undefined} title={TILE_SIZES[size].name}>
                {TILE_SIZES[size].label}
              </a>
            ))}
          </div>
        </div>
        <div class="store-frame">
          {view.total === 0 ? (
            <p class="store-empty">No apps are published on this deployment yet.</p>
          ) : (
            <div class={`tiles ${view.size}`}>
              {view.apps.map((app, i) => <Tile app={app} tone={view.offset + i} />)}
            </div>
          )}
          <Pagination view={view} />
        </div>
        <p class="mono-note store-count">
          {view.total} {view.total === 1 ? 'app' : 'apps'} &middot; register your own through the Admin Dashboard or SMART Dynamic Client Registration (RFC 7591)
        </p>
      </main>
      <div class="container"><SiteFooter source={view.source} /></div>
    </Document>
  )
}

export function appStoreResponse(apps: readonly DiscoveredApp[], query: AppStoreQuery = {}): Response {
  return htmlResponse(<AppStorePage view={appStoreView(apps, query)} />)
}
