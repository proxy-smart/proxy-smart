// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Readers for Keycloak's `{ [key]: string[] }` config and attributes and the flat `{ [key]: string }` views. */

import { isRecord, optionalString, stringList } from './type-guards'

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
  return stringList(attrs?.[key])
}

/** Safely read a Keycloak attribute (handles both string and string[] formats) */
export function getAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attrs?.[key]
  return optionalString(Array.isArray(value) ? value[0] : value)
}
