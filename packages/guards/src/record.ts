// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `value` as a JSON object; throws naming `what` when it is anything else. */
export function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} is not a JSON object`)
  return value
}

/** The string-valued entries of an object, such as Keycloak realm attributes; other values are dropped. */
export function stringEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/** Parsed JSON, or undefined when the text is absent or not JSON. */
export function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Parsed JSON when it is an object, or null when the text is absent, not JSON, or another JSON value. */
export function parseJsonRecord(text: string | undefined): Record<string, unknown> | null {
  const parsed = parseJson(text)
  return isRecord(parsed) ? parsed : null
}
