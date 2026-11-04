import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  getAppStoreConfig,
  getHiddenAppIds,
  getPublishedApps,
  hideApp,
  showApp,
  publishApp,
  unpublishApp,
} from '../src/lib/app-store-config'
import { adminConfigStore } from '../src/lib/admin-config-store'
import { DATA_DIR } from '../src/lib/paths'

const FILE = join(DATA_DIR, 'app-store-config.json')

beforeEach(() => {
  if (existsSync(FILE)) unlinkSync(FILE)
  adminConfigStore.invalidate('app-store')
})

afterEach(async () => {
  // Reset to a clean state for the next test.
  for (const id of [...getHiddenAppIds()]) await showApp(id)
  for (const app of [...getPublishedApps()]) await unpublishApp(app.clientId)
  adminConfigStore.invalidate('app-store')
  if (existsSync(FILE)) unlinkSync(FILE)
})

describe.serial('App Store Config — file fallback', () => {
  it('hides and shows apps, persisting the hidden list', async () => {
    await hideApp('app-a')
    await hideApp('app-b')
    expect(getHiddenAppIds().sort()).toEqual(['app-a', 'app-b'])

    await showApp('app-a')
    expect(getHiddenAppIds()).toEqual(['app-b'])
  })

  it('hideApp is idempotent', async () => {
    await hideApp('dup')
    await hideApp('dup')
    expect(getHiddenAppIds()).toEqual(['dup'])
  })

  it('publishes and unpublishes registered apps (upsert by clientId)', async () => {
    await publishApp({
      clientId: 'c1',
      name: 'One',
      description: 'first',
      launchUrl: 'https://example/one',
      category: 'clinical',
    })
    await publishApp({
      clientId: 'c1',
      name: 'One Updated',
      description: 'first again',
      launchUrl: 'https://example/one',
      category: 'clinical',
    })
    const published = getPublishedApps()
    expect(published).toHaveLength(1)
    expect(published[0].name).toBe('One Updated')

    await unpublishApp('c1')
    expect(getPublishedApps()).toHaveLength(0)
  })

  it('persists the config to the seeded DATA_DIR/app-store-config.json', async () => {
    await hideApp('persist-me')
    // Allow the background durable write kicked off by save() to flush.
    await adminConfigStore.set('app-store', getAppStoreConfig())
    expect(existsSync(FILE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(FILE, 'utf-8'))
    expect(onDisk.hiddenAppIds).toContain('persist-me')
  })

  it('survives a simulated restart by reloading from disk', async () => {
    await hideApp('survivor')
    await adminConfigStore.set('app-store', getAppStoreConfig())

    // Simulate a fresh task: drop the cache so the next read loads from file.
    adminConfigStore.invalidate('app-store')
    expect(getHiddenAppIds()).toContain('survivor')
  })

  it('reads the published apps from the file the image seeds', () => {
    writeFileSync(FILE, JSON.stringify({
      hiddenAppIds: [],
      publishedApps: [{ clientId: 'seeded-app', name: 'Seeded', description: 'd', launchUrl: 'https://example.test/', category: 'clinical' }],
    }))
    adminConfigStore.invalidate('app-store')

    expect(getPublishedApps().map((app) => app.clientId)).toEqual(['seeded-app'])
  })

  it('keeps reading a file already written under the store key', () => {
    const written = join(DATA_DIR, 'app-store.json')
    writeFileSync(FILE, JSON.stringify({ hiddenAppIds: [], publishedApps: [] }))
    writeFileSync(written, JSON.stringify({
      hiddenAppIds: [],
      publishedApps: [{ clientId: 'kept-app', name: 'Kept', description: 'd', launchUrl: 'https://example.test/', category: 'clinical' }],
    }))
    adminConfigStore.invalidate('app-store')

    try {
      expect(getPublishedApps().map((app) => app.clientId)).toEqual(['kept-app'])
    } finally {
      unlinkSync(written)
      adminConfigStore.invalidate('app-store')
    }
  })

  it('stamps updatedAt on every change', async () => {
    writeFileSync(FILE, JSON.stringify({ hiddenAppIds: [], publishedApps: [], updatedAt: '2000-01-01T00:00:00.000Z' }))
    adminConfigStore.invalidate('app-store')

    const config = await hideApp('stamped')
    expect(config.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
  })
})
