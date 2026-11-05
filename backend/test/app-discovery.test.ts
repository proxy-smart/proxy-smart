// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverApps, type DiscoveredApp } from '../src/lib/app-discovery'
import { appStoreAdminRoutes } from '../src/routes/admin/app-store'
import { getHiddenAppIds, getPublishedApps, hideApp, publishApp, showApp, unpublishApp } from '../src/lib/app-store-config'

const originalCwd = process.cwd()
let root = ''

const filesystemIds = (apps: DiscoveredApp[]): string[] => apps.filter(app => app.source === 'filesystem').map(app => app.id).sort()

function writeManifest(dir: string, manifest: Record<string, string>): void {
  mkdirSync(join(root, 'public', 'apps', dir), { recursive: true })
  writeFileSync(join(root, 'public', 'apps', dir, 'smart-manifest.json'), JSON.stringify(manifest))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'app-discovery-'))
  writeManifest('patient-portal', { client_id: 'patient-portal', client_name: 'Patient Portal', category: 'clinical' })
  writeManifest('consent', { client_id: 'consent-app', client_name: 'Consent Manager' })
  mkdirSync(join(root, 'public', 'apps', 'no-manifest'), { recursive: true })
  process.chdir(root)
})

afterEach(async () => {
  for (const id of [...getHiddenAppIds()]) await showApp(id)
  for (const app of [...getPublishedApps()]) await unpublishApp(app.clientId)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe.serial('discoverApps', () => {
  it('reads public/apps under the working directory, where the image and the compose volume put it', () => {
    expect(filesystemIds(discoverApps())).toEqual(['consent', 'patient-portal'])
  })

  it('flags hidden apps and lists them only when asked', async () => {
    await hideApp('consent')
    expect(filesystemIds(discoverApps())).toEqual(['patient-portal'])
    const consent = discoverApps({ includeHidden: true }).find(app => app.id === 'consent')
    expect(consent?.hidden).toBe(true)
  })

  it('lets a filesystem app win a client id it shares with a published app, even while hidden', async () => {
    const published = { name: 'Portal', description: '', launchUrl: 'https://portal.example', category: 'clinical' }
    await publishApp({ clientId: 'patient-portal', ...published })
    await publishApp({ clientId: 'viewer', ...published })
    await hideApp('patient-portal')

    const visible = discoverApps().map(app => app.client_id)
    expect(visible).toContain('viewer')
    expect(visible).not.toContain('patient-portal')
    const all = discoverApps({ includeHidden: true })
    expect(all.filter(app => app.client_id === 'patient-portal').map(app => app.source)).toEqual(['filesystem'])
  })

  it('serves the admin list from the same discovery, hidden apps included and flagged', async () => {
    await hideApp('consent')
    const response = await appStoreAdminRoutes.handle(new Request('http://localhost/app-store/'))
    expect(response.status).toBe(200)
    const body: { apps: DiscoveredApp[] } = await response.json()
    expect(body.apps.find(app => app.id === 'consent')?.hidden).toBe(true)
    expect(body.apps.find(app => app.id === 'patient-portal')?.hidden).toBe(false)
  })
})
