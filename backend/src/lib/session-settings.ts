// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Realm session lifetimes only: whitelisted fields, never a whole-realm update. Realm exports apply only at creation.

import type { SessionSettingsType } from '@/schemas'
import { isRecord } from './type-guards'

export type SessionSettings = SessionSettingsType

const DURATIONS = [
  'ssoSessionIdleTimeout',
  'ssoSessionMaxLifespan',
  'offlineSessionIdleTimeout',
  'offlineSessionMaxLifespan',
] as const

/** Drops unknown and wrongly typed keys so nothing else rides along into the realm. */
export function pickSessionSettings(input: unknown): SessionSettings {
  if (!isRecord(input)) return {}
  const out: SessionSettings = {}
  for (const key of DURATIONS) {
    const value = input[key]
    if (typeof value === 'number') out[key] = value
  }
  if (typeof input.offlineSessionMaxLifespanEnabled === 'boolean') {
    out.offlineSessionMaxLifespanEnabled = input.offlineSessionMaxLifespanEnabled
  }
  return out
}

/** Rejection reason for a 400, or undefined. Keycloak accepts all of these silently. */
export function validateSessionSettings(input: SessionSettings): string | undefined {
  const settings = pickSessionSettings(input)

  for (const key of DURATIONS) {
    const value = settings[key]
    if (value === undefined) continue
    if (!Number.isInteger(value)) return `${key} must be a whole number of seconds`
    if (value <= 0) return `${key} must be greater than zero (Keycloak treats 0 as unlimited)`
  }

  if (
    settings.ssoSessionMaxLifespan !== undefined &&
    settings.ssoSessionIdleTimeout !== undefined &&
    settings.ssoSessionMaxLifespan <= settings.ssoSessionIdleTimeout
  ) {
    return 'ssoSessionMaxLifespan must exceed ssoSessionIdleTimeout'
  }
  if (
    settings.offlineSessionMaxLifespan !== undefined &&
    settings.offlineSessionIdleTimeout !== undefined &&
    settings.offlineSessionMaxLifespan <= settings.offlineSessionIdleTimeout
  ) {
    return 'offlineSessionMaxLifespan must exceed offlineSessionIdleTimeout'
  }

  if (settings.offlineSessionMaxLifespanEnabled === true && settings.offlineSessionMaxLifespan === 0) {
    return 'offlineSessionMaxLifespan must be set when enabling the offline session ceiling'
  }

  return undefined
}
