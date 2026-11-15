// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Logs keep a user's id only; who that is gets looked up in Keycloak when an event is shown. */

import { TtlCache } from './cache/ttl-cache'
import { getAdminClient } from './kc-admin-factory'
import { isRecord } from './type-guards'

const LABEL_TTL_MS = 10 * 60_000
const labels = new TtlCache<string | null>({ ttlMs: LABEL_TTL_MS, maxEntries: 5_000, cleanupIntervalMs: 60_000 })

/** Keycloak event detail keys that name a person rather than identify a record. */
const PERSONAL_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'username',
  'email',
  'identity_provider_identity',
  'previous_email',
  'updated_email',
])

export type UserLabelLookup = (userId: string) => Promise<string | null>

async function loadLabel(userId: string): Promise<string | null> {
  const admin = await getAdminClient()
  if (!admin) return null
  const user = await admin.users.findOne({ id: userId })
  return user?.username ?? null
}

/** The username behind a user id, null when there is none or Keycloak cannot say. */
export const keycloakUserLabel: UserLabelLookup = async (userId) => {
  try {
    return await labels.getOrLoad(userId, () => loadLabel(userId))
  } catch {
    return null
  }
}

/** Labels for every distinct id at once, so a page of events costs one lookup per user. */
export async function labelsFor(
  userIds: Iterable<string | null | undefined>,
  lookup: UserLabelLookup = keycloakUserLabel,
): Promise<ReadonlyMap<string, string>> {
  const distinct = [...new Set([...userIds].filter((id): id is string => !!id && id !== 'unknown'))]
  const resolved = await Promise.all(distinct.map(async (id) => [id, await lookup(id)] as const))
  return new Map(resolved.flatMap(([id, label]) => (label ? [[id, label] as const] : [])))
}

/** A Keycloak event without the details that name a person; the user id stays. */
export function withoutPersonalDetails<T extends object>(event: T): T {
  if (!('details' in event) || !isRecord(event.details)) return event
  const details = Object.fromEntries(Object.entries(event.details).filter(([key]) => !PERSONAL_DETAIL_KEYS.has(key)))
  return { ...event, details }
}
