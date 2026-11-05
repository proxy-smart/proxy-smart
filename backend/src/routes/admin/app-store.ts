// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { logger } from '@/lib/logger'
import { getAppStoreConfig, hideApp, showApp, publishApp, unpublishApp } from '@/lib/app-store-config'
import { discoverApps } from '@/lib/app-discovery'

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
  .get('/', () => {
    const config = getAppStoreConfig()
    return {
      apps: discoverApps({ includeHidden: true }),
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
