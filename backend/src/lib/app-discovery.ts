// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { getHiddenAppIds, getPublishedApps } from './app-store-config'
import { resolveAppIcon } from './app-store-icons'

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

const APPS_DIR = join(import.meta.dir, '..', '..', 'public', 'apps')

function readManifestApp(dirName: string, hiddenIds: readonly string[]): DiscoveredApp | null {
    const manifestPath = join(APPS_DIR, dirName, 'smart-manifest.json')
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
            hidden: hiddenIds.includes(dirName),
            source: 'filesystem',
        }
    } catch {
        return null
    }
}

export function discoverApps({ includeHidden = false } = {}): DiscoveredApp[] {
    const hiddenIds = includeHidden ? [] : getHiddenAppIds()

    const fsApps = !existsSync(APPS_DIR) ? [] : readdirSync(APPS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => readManifestApp(d.name, hiddenIds))
        .filter((app): app is DiscoveredApp => app !== null && (includeHidden || !app.hidden))

    const publishedApps = getPublishedApps()
        .filter(pa => !hiddenIds.includes(pa.clientId))
        .map((pa): DiscoveredApp => {
            const { icon, logoUri } = resolveAppIcon(pa.logoUri, pa.category)
            return {
                id: pa.clientId,
                launch_url: pa.launchUrl,
                client_id: pa.clientId,
                client_name: pa.name,
                description: pa.description,
                scope: '',
                category: pa.category,
                icon,
                logoUri,
                grant_types: ['authorization_code'],
                token_endpoint_auth_method: 'none',
                hidden: false,
                source: 'registered',
            }
        })

    const fsClientIds = new Set(fsApps.map(a => a.client_id))
    return [...fsApps, ...publishedApps.filter(pa => !fsClientIds.has(pa.client_id))]
}
