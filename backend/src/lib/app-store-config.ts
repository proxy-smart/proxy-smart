// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import {
  AppStoreConfigStore,
  normalizeAppStoreConfig,
  type AppStoreConfig,
  type AppStoreConfigPersistence,
  type PublishedApp,
} from '@proxy-smart/app-store'
import { logger } from './logger'
import { adminConfigStore, type AdminConfigValue } from './admin-config-store'

export type { AppStoreConfig, PublishedApp }

const CONFIG_KEY = 'app-store'

const DEFAULTS: AppStoreConfig = {
  hiddenAppIds: [],
  publishedApps: [],
  updatedAt: new Date().toISOString(),
}

function mergeConfig(_defaults: AppStoreConfig, raw: AdminConfigValue | null): AppStoreConfig {
  return normalizeAppStoreConfig(raw)
}

/** The package's persistence contract is sync; the shared store's cache makes that hold. */
const sharedStorePersistence: AppStoreConfigPersistence = {
  load(): AppStoreConfig {
    return adminConfigStore.get<AppStoreConfig>(CONFIG_KEY, DEFAULTS, mergeConfig)
  },
  save(config: AppStoreConfig): void {
    void adminConfigStore.set(CONFIG_KEY, config).catch((error: unknown) => {
      logger.server.warn('Failed to persist app-store config', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  },
}

const store = new AppStoreConfigStore({
  persistence: sharedStorePersistence,
  logger: { warn: (msg, meta) => logger.server.warn(msg, meta) },
})

/** Re-read from the shared store so a write from another task is seen within its TTL. */
function syncedStore(): AppStoreConfigStore {
  store.reload()
  return store
}

export function getHiddenAppIds(): string[] {
  return syncedStore().getHiddenAppIds()
}

export function getAppStoreConfig(): AppStoreConfig {
  return syncedStore().getConfig()
}

export function getPublishedApps(): PublishedApp[] {
  return syncedStore().getPublishedApps()
}

/** Compare-and-set against the current document, never the package store's in-memory copy. */
async function mutateConfig(update: (current: AppStoreConfig) => AppStoreConfig): Promise<AppStoreConfig> {
  const next = await adminConfigStore.mutate<AppStoreConfig>(CONFIG_KEY, DEFAULTS, mergeConfig, (current) => {
    const changed = update(current)
    return changed === current ? current : { ...changed, updatedAt: new Date().toISOString() }
  })
  store.reload()
  return next
}

export function setHiddenAppIds(ids: string[]): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({ ...current, hiddenAppIds: [...ids] }))
}

export function publishApp(app: PublishedApp): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({
    ...current,
    publishedApps: [...current.publishedApps.filter((a) => a.clientId !== app.clientId), app],
  }))
}

export function unpublishApp(clientId: string): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({
    ...current,
    publishedApps: current.publishedApps.filter((a) => a.clientId !== clientId),
  }))
}

export function hideApp(appId: string): Promise<AppStoreConfig> {
  return mutateConfig((current) =>
    current.hiddenAppIds.includes(appId)
      ? current
      : { ...current, hiddenAppIds: [...current.hiddenAppIds, appId] },
  )
}

export function showApp(appId: string): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({
    ...current,
    hiddenAppIds: current.hiddenAppIds.filter((id) => id !== appId),
  }))
}
