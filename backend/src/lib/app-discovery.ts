// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { getHiddenAppIds, getPublishedApps, type PublishedApp } from './app-store-config'
import { resolveAppIcon } from './app-store-icons'
import { PUBLIC_APPS_DIR } from './paths'

export interface DiscoveredApp {
    id: string
    launch_url: string
    client_id: string
    client_name: string
    description: string
    scope: string
    category: string
    icon: string
    logoUri?: string
    grant_types: string[]
    token_endpoint_auth_method: string
    hidden: boolean
    source: 'filesystem' | 'registered'
}

function readManifestApp(dirName: string, hiddenIds: ReadonlySet<string>): DiscoveredApp | null {
    const manifestPath = join(PUBLIC_APPS_DIR, dirName, 'smart-manifest.json')
    if (!existsSync(manifestPath)) return null
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        const { icon, logoUri } = resolveAppIcon(manifest.logoUri ?? manifest.icon, manifest.category)
        return {
            id: dirName,
            launch_url: `/apps/${dirName}/`,
            client_id: manifest.client_id ?? dirName,
            client_name: manifest.client_name ?? dirName,
            description: manifest.description ?? '',
            scope: manifest.scope ?? '',
            category: manifest.category ?? 'other',
            icon,
            logoUri,
            grant_types: manifest.grant_types ?? ['authorization_code'],
            token_endpoint_auth_method: manifest.token_endpoint_auth_method ?? 'none',
            hidden: hiddenIds.has(dirName),
            source: 'filesystem',
        }
    } catch {
        return null
    }
}

function filesystemApps(hiddenIds: ReadonlySet<string>): DiscoveredApp[] {
    if (!existsSync(PUBLIC_APPS_DIR)) return []
    return readdirSync(PUBLIC_APPS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .flatMap(entry => readManifestApp(entry.name, hiddenIds) ?? [])
}

function publishedApp(app: PublishedApp, hiddenIds: ReadonlySet<string>): DiscoveredApp {
    const { icon, logoUri } = resolveAppIcon(app.logoUri, app.category)
    return {
        id: app.clientId,
        launch_url: app.launchUrl,
        client_id: app.clientId,
        client_name: app.name,
        description: app.description,
        scope: '',
        category: app.category,
        icon,
        logoUri,
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none',
        hidden: hiddenIds.has(app.clientId),
        source: 'registered',
    }
}

/** Filesystem apps under public/apps plus published registered apps; a filesystem app wins a shared client id. */
export function discoverApps({ includeHidden = false } = {}): DiscoveredApp[] {
    const hiddenIds = new Set(getHiddenAppIds())
    const fsApps = filesystemApps(hiddenIds)
    const fsClientIds = new Set(fsApps.map(app => app.client_id))
    const apps = [
        ...fsApps,
        ...getPublishedApps().filter(app => !fsClientIds.has(app.clientId)).map(app => publishedApp(app, hiddenIds)),
    ]
    return includeHidden ? apps : apps.filter(app => !app.hidden)
}
