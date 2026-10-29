// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Expired DCR clients are disabled first, deleted only if still disabled after the grace period.
// Clients without expires_at (pre-policy registrations) are never touched.

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { logger } from './logger'
import { getAttr } from './keycloak-component-config'
import { withoutMaskedSecret } from './secret-mask'

const DCR_ATTRIBUTE = 'dynamic_registration'
/** Epoch ms. */
const EXPIRES_AT_ATTRIBUTE = 'expires_at'
/** Epoch ms, set when the reaper disables the client. */
const EXPIRED_AT_ATTRIBUTE = 'expired_at'

export const DEFAULT_GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export interface ReapResult {
  disabled: string[]
  deleted: string[]
}

function attr(client: ClientRepresentation, key: string): string | undefined {
  return getAttr(client.attributes, key) || undefined
}

function timestamp(client: ClientRepresentation, key: string): number | undefined {
  const raw = attr(client, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function isReapable(client: ClientRepresentation): boolean {
  return attr(client, DCR_ATTRIBUTE) === 'true' && timestamp(client, EXPIRES_AT_ATTRIBUTE) !== undefined
}

export function verdictFor(
  client: ClientRepresentation,
  now: number,
  graceMs: number,
): 'keep' | 'disable' | 'delete' {
  if (!isReapable(client)) return 'keep'

  const expiredAt = timestamp(client, EXPIRED_AT_ATTRIBUTE)
  if (expiredAt !== undefined) {
    // Re-enabling a retired client cancels deletion.
    if (client.enabled === false && now - expiredAt >= graceMs) return 'delete'
    return 'keep'
  }

  const expiresAt = timestamp(client, EXPIRES_AT_ATTRIBUTE)
  return expiresAt !== undefined && now >= expiresAt ? 'disable' : 'keep'
}

/** Never throws: per-client failures are logged so one client cannot stop the sweep. */
export async function reapExpiredClients(
  admin: KcAdminClient,
  options: { now?: number; graceDays?: number } = {},
): Promise<ReapResult> {
  const now = options.now ?? Date.now()
  const graceMs = (options.graceDays ?? DEFAULT_GRACE_DAYS) * DAY_MS
  const result: ReapResult = { disabled: [], deleted: [] }

  let clients: ClientRepresentation[]
  try {
    clients = await admin.clients.find()
  } catch (error) {
    logger.admin.warn('DCR reaper: could not list clients', { error })
    return result
  }

  for (const client of clients) {
    if (!client.id || !client.clientId) continue
    const verdict = verdictFor(client, now, graceMs)
    if (verdict === 'keep') continue

    try {
      if (verdict === 'disable') {
        await admin.clients.update(
          { id: client.id },
          {
            ...withoutMaskedSecret(client),
            enabled: false,
            attributes: { ...client.attributes, [EXPIRED_AT_ATTRIBUTE]: now.toString() },
          },
        )
        result.disabled.push(client.clientId)
        logger.admin.warn('DCR reaper: client passed its registered lifetime and was disabled', {
          clientId: client.clientId,
          graceDays: options.graceDays ?? DEFAULT_GRACE_DAYS,
          note: 're-enable it to cancel deletion',
        })
      } else {
        await admin.clients.del({ id: client.id })
        result.deleted.push(client.clientId)
        logger.admin.warn('DCR reaper: expired client deleted after its grace period', {
          clientId: client.clientId,
        })
      }
    } catch (error) {
      logger.admin.warn('DCR reaper: could not retire client', { clientId: client.clientId, error, verdict })
    }
  }

  if (result.disabled.length > 0 || result.deleted.length > 0) {
    logger.admin.info('DCR reaper sweep complete', {
      disabled: result.disabled.length,
      deleted: result.deleted.length,
    })
  }
  return result
}

let reaperTimer: ReturnType<typeof setInterval> | null = null

/** Idempotent. In-process so it runs on customer deployments too. */
export function startDcrClientReaper(
  getAdmin: () => Promise<KcAdminClient>,
  options: { intervalMs?: number; graceDays?: number } = {},
): void {
  if (reaperTimer) return
  const intervalMs = options.intervalMs ?? DAY_MS
  const sweep = (): void => {
    getAdmin()
      .then((admin) => reapExpiredClients(admin, { graceDays: options.graceDays }))
      .catch((error) =>
        logger.admin.debug('DCR reaper sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
  }
  reaperTimer = setInterval(sweep, intervalMs)
  reaperTimer.unref?.()
}

export function stopDcrClientReaper(): void {
  if (!reaperTimer) return
  clearInterval(reaperTimer)
  reaperTimer = null
}
