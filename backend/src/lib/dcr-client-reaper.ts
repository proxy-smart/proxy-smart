// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Retire dynamically-registered clients that have outlived their registered lifetime.
 *
 * THE GAP THIS CLOSES. Dynamic client registration already stamps every client it creates with
 * an `expires_at` attribute, computed from the `maxClientLifetime` admin setting (365 days by
 * default, editable in the admin UI, shown there as a stat card). Nothing ever read it. So the
 * setting was decorative and every DCR client Proxy Smart has ever issued lives forever — an
 * unbounded pile of credentials nobody is watching, which is a security problem before it is a
 * tidiness one.
 *
 * NO RFC ASKS FOR THIS. RFC 7592 covers only client-INITIATED deregistration (see
 * routes/auth/client-registration.ts) and explicitly leaves server-side cleanup out of scope.
 * A well-behaved client deletes itself; this exists for the ones that never will, which in
 * practice is most of them.
 *
 * TWO PHASES, NOT ONE. Deleting an OAuth client breaks whatever was using it, and no amount of
 * care makes an expiry heuristic perfect. So expiry first DISABLES the client and records
 * `expired_at`; deletion happens only if it is still disabled a grace period later. A client
 * retired by mistake therefore fails loudly, stays visible in the admin UI, and is one flag
 * away from working again — for a window measured in weeks. Re-enable it and this leaves it
 * alone, because phase two only removes clients that are still disabled.
 *
 * WHAT IT WILL NOT TOUCH:
 *   - anything without `dynamic_registration=true` — first-party clients from realm-export are
 *     not its business
 *   - anything without an `expires_at` — including every client registered before that
 *     attribute existed. Absence means "no lifetime was ever agreed", not "expired long ago",
 *     and back-dating one would delete clients that predate the policy.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { logger } from './logger'
import { getAttr } from './keycloak-component-config'

/** Marks a client as created through dynamic registration. Set at registration. */
const DCR_ATTRIBUTE = 'dynamic_registration'
/** Epoch ms after which the client has outlived its registered lifetime. Set at registration. */
const EXPIRES_AT_ATTRIBUTE = 'expires_at'
/** Epoch ms at which this reaper disabled the client. Set by phase one. */
const EXPIRED_AT_ATTRIBUTE = 'expired_at'

/** How long a disabled, expired client is kept before deletion. */
export const DEFAULT_GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export interface ReapResult {
  /** Clients disabled this pass because they passed `expires_at`. */
  disabled: string[]
  /** Clients deleted this pass because the grace period elapsed while still disabled. */
  deleted: string[]
}

function attr(client: ClientRepresentation, key: string): string | undefined {
  return getAttr(client.attributes, key) || undefined
}

/** An attribute holding epoch milliseconds, or undefined when absent or unparseable. */
function timestamp(client: ClientRepresentation, key: string): number | undefined {
  const raw = attr(client, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Whether this reaper is allowed to act on a client at all. */
export function isReapable(client: ClientRepresentation): boolean {
  return attr(client, DCR_ATTRIBUTE) === 'true' && timestamp(client, EXPIRES_AT_ATTRIBUTE) !== undefined
}

/**
 * What should happen to one client right now.
 *
 * Pure, so the policy is testable without a Keycloak. `enabled` is the pivot for phase two: an
 * operator who re-enables a wrongly-retired client takes it back out of scope, and it will not
 * be deleted no matter how long ago it expired.
 */
export function verdictFor(
  client: ClientRepresentation,
  now: number,
  graceMs: number,
): 'keep' | 'disable' | 'delete' {
  if (!isReapable(client)) return 'keep'

  const expiredAt = timestamp(client, EXPIRED_AT_ATTRIBUTE)
  if (expiredAt !== undefined) {
    // Phase two. Only clients still disabled are removed; re-enabling is a reprieve.
    if (client.enabled === false && now - expiredAt >= graceMs) return 'delete'
    return 'keep'
  }

  const expiresAt = timestamp(client, EXPIRES_AT_ATTRIBUTE)
  return expiresAt !== undefined && now >= expiresAt ? 'disable' : 'keep'
}

/**
 * Run one sweep.
 *
 * Every client is handled independently and failures are logged rather than thrown: one client
 * Keycloak refuses to touch must not stop the rest of the sweep, and this runs unattended on a
 * timer where an exception would simply vanish.
 */
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
            ...client,
            enabled: false,
            attributes: { ...client.attributes, [EXPIRED_AT_ATTRIBUTE]: now.toString() },
          },
        )
        result.disabled.push(client.clientId)
        // warn, not info: somebody's integration just stopped working, and the grace window is
        // only useful if this is visible while it is still open.
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

/**
 * Start the periodic sweep (idempotent to call).
 *
 * Daily by default. The unit of the policy is days, so a tighter interval buys nothing and
 * costs a full client listing against Keycloak each time. In-process rather than a CI cron
 * because this has to run on customer deployments too, not only on ours.
 */
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

/** Stop the sweep. Exists for tests and graceful shutdown. */
export function stopDcrClientReaper(): void {
  if (!reaperTimer) return
  clearInterval(reaperTimer)
  reaperTimer = null
}
