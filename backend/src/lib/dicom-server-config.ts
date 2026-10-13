// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * DICOM server configuration, upstream credentials included. Kept in the admin
 * config store (Postgres when DATABASE_URL is set), never in Keycloak realm
 * attributes, which every view-realm holder and every realm export can read.
 */

import { Value } from '@sinclair/typebox/value'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { DicomServerConfig, type DicomServerConfigType } from '@/schemas'
import { adminConfigStore, type AdminConfigStore, type AdminConfigValue } from './admin-config-store'

const CONFIG_KEY = 'dicom-servers'

/** The realm attribute these servers were kept in before the admin config store. */
export const LEGACY_DICOM_SERVERS_ATTRIBUTE = 'dicom_servers'

interface StoredDicomServers {
  servers: DicomServerConfigType[]
}

const DEFAULTS: StoredDicomServers = { servers: [] }

function toDicomServers(raw: unknown): DicomServerConfigType[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((server): server is DicomServerConfigType => Value.Check(DicomServerConfig, server))
}

function merge(_defaults: StoredDicomServers, raw: AdminConfigValue | null): StoredDicomServers {
  return { servers: toDicomServers(raw?.servers) }
}

/** A single server synthesized from DICOMWEB_* when none is configured. */
function envFallbackServers(): DicomServerConfigType[] {
  if (!config.dicomweb.enabled || !config.dicomweb.baseUrl) return []
  return [{
    id: 'env-default',
    name: 'Default PACS',
    baseUrl: config.dicomweb.baseUrl,
    wadoRoot: config.dicomweb.wadoRoot || undefined,
    qidoRoot: config.dicomweb.qidoRoot || undefined,
    authType: config.dicomweb.upstreamAuth ? 'header' : 'none',
    authHeader: config.dicomweb.upstreamAuth || undefined,
    timeoutMs: config.dicomweb.timeoutMs,
    isDefault: true,
  }]
}

/** Configured servers, else the env fallback. */
export function getRuntimeDicomServers(store: AdminConfigStore = adminConfigStore): DicomServerConfigType[] {
  const { servers } = store.get(CONFIG_KEY, DEFAULTS, merge)
  return servers.length > 0 ? servers : envFallbackServers()
}

/** The server flagged default, else the first one: where unscoped /dicomweb requests go */
export function pickDefaultDicomServer(servers: readonly DicomServerConfigType[]): DicomServerConfigType | null {
  return servers.find(s => s.isDefault) ?? servers[0] ?? null
}

export function getDefaultDicomServer(store: AdminConfigStore = adminConfigStore): DicomServerConfigType | null {
  return pickDefaultDicomServer(getRuntimeDicomServers(store))
}

export function getDicomServerById(id: string, store: AdminConfigStore = adminConfigStore): DicomServerConfigType | null {
  return getRuntimeDicomServers(store).find(s => s.id === id) ?? null
}

/** Read-modify-write of the server list, safe against a concurrent write from another task. */
export async function updateDicomServers(
  update: (servers: DicomServerConfigType[]) => DicomServerConfigType[],
  store: AdminConfigStore = adminConfigStore,
): Promise<DicomServerConfigType[]> {
  const next = await store.mutate(CONFIG_KEY, DEFAULTS, merge, current => ({
    servers: update(current.servers.length > 0 ? current.servers : envFallbackServers()),
  }))
  return next.servers
}

/** Load the persisted list before serving, so no request sees the empty default. */
export async function loadDicomServers(store: AdminConfigStore = adminConfigStore): Promise<void> {
  await store.reload(CONFIG_KEY, DEFAULTS, merge)
}

/**
 * Move servers out of the legacy realm attribute. An existing store list wins.
 * True when the attribute can be deleted: the store holds the servers durably.
 */
export async function adoptLegacyDicomServers(
  rawAttribute: string,
  store: AdminConfigStore = adminConfigStore,
): Promise<boolean> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawAttribute)
  } catch {
    logger.admin.warn('Legacy dicom_servers realm attribute is not JSON; leaving it in place')
    return false
  }
  const legacy = toDicomServers(parsed)
  if (legacy.length === 0) return false

  const { servers } = await store.mutate(CONFIG_KEY, DEFAULTS, merge, current =>
    current.servers.length > 0 ? current : { servers: legacy },
  )
  logger.admin.info('DICOM servers held in the admin config store', { count: servers.length })
  return servers.length > 0 && store.persistsDurably
}
