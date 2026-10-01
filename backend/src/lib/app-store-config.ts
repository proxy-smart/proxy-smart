// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { AppStoreConfigStore, normalizeAppStoreConfig } from '@proxy-smart/app-store'
import type {
  AppStoreConfig,
  AppStoreConfigPersistence,
  PublishedApp,
} from '@proxy-smart/app-store'
import { logger } from './logger'
import { adminConfigStore, type AdminConfigValue } from './admin-config-store'

export type { AppStoreConfig, PublishedApp }

/** Storage key — also the filename stem (`app-store-config.json`) in file mode. */
const CONFIG_KEY = 'app-store'

const DEFAULTS: AppStoreConfig = {
  hiddenAppIds: [],
  publishedApps: [],
  updatedAt: new Date().toISOString(),
}

function mergeConfig(_defaults: AppStoreConfig, raw: AdminConfigValue | null): AppStoreConfig {
  return normalizeAppStoreConfig(raw)
}

/**
 * Persistence adapter backing the app-store config with the shared admin-config
 * store (Postgres when DATABASE_URL is set, else the existing
 * `DATA_DIR/app-store-config.json` file). The package's persistence contract is
 * synchronous; the shared store updates its cache synchronously on write and
 * persists durably in the background, so this stays sync while remaining
 * cluster-safe.
 */
const sharedStorePersistence: AppStoreConfigPersistence = {
  load(): AppStoreConfig {
    return adminConfigStore.get<AppStoreConfig>(CONFIG_KEY, DEFAULTS, mergeConfig)
  },
  save(config: AppStoreConfig): void {
    // Cache is updated synchronously inside set(); the durable write happens in
    // the background. We swallow rejection here (logged) so a transient DB error
    // never surfaces as an unhandled rejection — the in-memory state is already
    // current and the next mutation will retry persistence.
    void adminConfigStore.set(CONFIG_KEY, config).catch((error: unknown) => {
      logger.server.warn('Failed to persist app-store config', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  },
}

/** Singleton config store instance backed by the shared admin-config store */
const store = new AppStoreConfigStore({
  persistence: sharedStorePersistence,
  logger: { warn: (msg, meta) => logger.server.warn(msg, meta) },
})

/**
 * Re-hydrate the package store's in-process state from the shared store before
 * every read/mutation. The shared store's short-TTL cache is the convergence
 * mechanism: this keeps each operation working on fresh state (so a write from
 * another task is observed) and ensures mutations build on the latest config
 * rather than a stale in-process copy. Reads here are cheap and cache-backed.
 */
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

/**
 * Every mutation goes through the shared store's compare-and-set.
 *
 * The package store mutates a whole document in memory and persists it last-writer-wins, which loses
 * updates the moment two tasks write: publishing one app unpublished another that the writing task
 * had never read. These build the next document from the CURRENT one and retry on conflict, so a
 * concurrent publish is merged rather than dropped.
 */
async function mutateConfig(update: (current: AppStoreConfig) => AppStoreConfig): Promise<AppStoreConfig> {
  const next = await adminConfigStore.mutate<AppStoreConfig>(CONFIG_KEY, DEFAULTS, mergeConfig, update)
  // Keep the package store's in-process view in step for the sync readers above.
  store.reload()
  return next
}

export function setHiddenAppIds(ids: string[]): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({ ...current, hiddenAppIds: [...ids] }))
}

export function publishApp(app: PublishedApp): Promise<AppStoreConfig> {
  return mutateConfig((current) => ({
    ...current,
    // Replace an existing entry in place rather than appending a duplicate.
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
