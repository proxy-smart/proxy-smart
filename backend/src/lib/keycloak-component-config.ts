// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak multi-valued map helpers.
 *
 * Keycloak stores component config (user federation providers, LDAP and IdP
 * mappers, ...) and user/role attributes as `{ [key]: string[] }`, while client
 * attributes and the admin API's flat views use `{ [key]: string }`. Every
 * reader of either shape goes through here.
 */

import { isRecord, stringArray } from './type-guards'

/** Convert a flat config object to Keycloak's string-array config format. */
export const toKeycloakConfig = (cfg: Record<string, unknown>): Record<string, string[]> => {
  const result: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(cfg)) {
    if (value === undefined || value === null) continue
    result[key] = [String(value)]
  }
  return result
}

/** Flatten Keycloak's string-array config into a plain string record. */
export const fromKeycloakConfig = (cfg?: unknown): Record<string, string> => {
  if (!isRecord(cfg)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(cfg)) {
    if (value === undefined || value === null) continue
    result[key] = Array.isArray(value) ? String(value[0] ?? '') : String(value)
  }
  return result
}

export function getAttrValues(attrs: Record<string, unknown> | undefined, key: string): string[] {
  const value = attrs?.[key]
  return typeof value === 'string' ? [value] : stringArray(value) ?? []
}

/** Safely read a Keycloak attribute (handles both string and string[] formats) */
export function getAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attrs?.[key]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}
