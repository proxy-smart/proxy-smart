// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { logger } from '@/lib/logger'
import { getAppStoreConfig, hideApp, showApp, publishApp, unpublishApp } from '@/lib/app-store-config'
import { resolveAppIcon } from '@/lib/app-store-icons'

/**
 * Admin App Store management routes.
 * Lets admins list all discovered + published apps and toggle visibility.
 */

type AppStoreAppType = {
  id: string; launch_url: string; client_id: string; client_name: string;
  description: string; category: string; icon: string; hidden: boolean; source: 'filesystem' | 'registered'
}

/** Discover all filesystem apps (unfiltered) */
function discoverAllApps(): AppStoreAppType[] {
  const appsDir = join(process.cwd(), 'public', 'apps')
  if (!existsSync(appsDir)) return []

  const { hiddenAppIds } = getAppStoreConfig()

  return readdirSync(appsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap((d): AppStoreAppType[] => {
      const manifestPath = join(appsDir, d.name, 'smart-manifest.json')
      if (!existsSync(manifestPath)) return []
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        return [{
          id: d.name,
          launch_url: `/apps/${d.name}/`,
          client_id: manifest.client_id ?? d.name,
          client_name: manifest.client_name ?? d.name,
          description: manifest.description ?? '',
          category: manifest.category ?? 'other',
          icon: resolveAppIcon(manifest.logoUri ?? manifest.icon, manifest.category).icon,
          hidden: hiddenAppIds.includes(d.name),
          source: 'filesystem',
        }]
      } catch { return [] }
    })
}

/** Merge filesystem-discovered apps with published registered apps */
function getAllStoreApps(): AppStoreAppType[] {
  const fsApps = discoverAllApps()
  const config = getAppStoreConfig()
  const fsClientIds = new Set(fsApps.map(a => a.client_id))

  const publishedApps: AppStoreAppType[] = config.publishedApps
    .filter(pa => !fsClientIds.has(pa.clientId))
    .map(pa => ({
      id: pa.clientId,
      launch_url: pa.launchUrl,
      client_id: pa.clientId,
      client_name: pa.name,
      description: pa.description,
      category: pa.category,
      icon: resolveAppIcon(pa.logoUri, pa.category).icon,
      hidden: config.hiddenAppIds.includes(pa.clientId),
      source: 'registered' as const,
    }))

  return [...fsApps, ...publishedApps]
}

const AppStoreApp = t.Object({
  id: t.String(),
  launch_url: t.String(),
  client_id: t.String(),
  client_name: t.String(),
  description: t.String(),
  category: t.String(),
  icon: t.String(),
  hidden: t.Boolean(),
  source: t.UnionEnum(['filesystem', 'registered']),
}, { title: 'AppStoreApp' })

const PublishedAppSchema = t.Object({
  clientId: t.String(),
  name: t.String(),
  description: t.String(),
  launchUrl: t.String(),
  category: t.String(),
  logoUri: t.Optional(t.String()),
}, { title: 'PublishedApp' })

const AppStoreListResponse = t.Object({
  apps: t.Array(AppStoreApp),
  publishedApps: t.Array(PublishedAppSchema),
  hiddenAppIds: t.Array(t.String()),
  updatedAt: t.String(),
}, { title: 'AppStoreListResponse' })

const AppStoreToggleResponse = t.Object({
  success: t.Boolean(),
  hiddenAppIds: t.Array(t.String()),
  updatedAt: t.String(),
}, { title: 'AppStoreToggleResponse' })

const AppStorePublishResponse = t.Object({
  success: t.Boolean(),
  publishedApps: t.Array(PublishedAppSchema),
  updatedAt: t.String(),
}, { title: 'AppStorePublishResponse' })

export const appStoreAdminRoutes = new Elysia({ prefix: '/app-store' })
  // GET /admin/app-store — list all apps (filesystem + published) with visibility status
  .get('/', () => {
    const apps = getAllStoreApps()
    const config = getAppStoreConfig()
    return {
      apps,
      publishedApps: config.publishedApps,
      hiddenAppIds: config.hiddenAppIds,
      updatedAt: config.updatedAt,
    }
  }, {
    response: { 200: AppStoreListResponse },
    detail: {
      summary: 'List App Store Apps',
      description: 'List all discovered and published SMART apps with their visibility status',
      tags: ['app-store'],
    },
  })
  // POST /admin/app-store/:appId/hide — hide an app from the public store
  .post('/:appId/hide', async ({ params }) => {
    const config = await hideApp(params.appId)
    logger.server.info(`App store: hid app "${params.appId}"`)
    return { success: true, hiddenAppIds: config.hiddenAppIds, updatedAt: config.updatedAt }
  }, {
    params: t.Object({ appId: t.String() }),
    response: { 200: AppStoreToggleResponse },
    detail: {
      summary: 'Hide App from Store',
      description: 'Hide a SMART app from the public app store page',
      tags: ['app-store'],
    },
  })
  // POST /admin/app-store/:appId/show — show an app in the public store
  .post('/:appId/show', async ({ params }) => {
    const config = await showApp(params.appId)
    logger.server.info(`App store: showed app "${params.appId}"`)
    return { success: true, hiddenAppIds: config.hiddenAppIds, updatedAt: config.updatedAt }
  }, {
    params: t.Object({ appId: t.String() }),
    response: { 200: AppStoreToggleResponse },
    detail: {
      summary: 'Show App in Store',
      description: 'Show a previously hidden SMART app in the public app store page',
      tags: ['app-store'],
    },
  })
  // POST /admin/app-store/publish — publish a registered app to the store
  .post('/publish', async ({ body }) => {
    const config = await publishApp(body)
    logger.server.info(`App store: published registered app "${body.clientId}" (${body.name})`)
    return { success: true, publishedApps: config.publishedApps, updatedAt: config.updatedAt }
  }, {
    body: PublishedAppSchema,
    response: {
      200: AppStorePublishResponse,
    },
    detail: {
      summary: 'Publish App to Store',
      description: 'Publish a registered SMART app to the public app store',
      tags: ['app-store'],
    },
  })
  // POST /admin/app-store/:appId/unpublish — remove a registered app from the store
  .post('/:appId/unpublish', async ({ params }) => {
    const config = await unpublishApp(params.appId)
    logger.server.info(`App store: unpublished registered app "${params.appId}"`)
    return { success: true, publishedApps: config.publishedApps, updatedAt: config.updatedAt }
  }, {
    params: t.Object({ appId: t.String() }),
    response: {
      200: AppStorePublishResponse,
    },
    detail: {
      summary: 'Unpublish App from Store',
      description: 'Remove a registered SMART app from the public app store',
      tags: ['app-store'],
    },
  })
