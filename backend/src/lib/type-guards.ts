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

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** A value that may be one string or a list of them, such as a JWT `aud` or a Keycloak attribute, as a list. */
export function stringList(value: unknown): string[] {
  return typeof value === 'string' ? [value] : stringArray(value) ?? []
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Whether `value` is one of a closed set of literals, narrowing it to that union. */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((allowed) => allowed === value)
}

/** The string-valued entries of an object, such as Keycloak realm attributes; other values are dropped. */
export function stringEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/** A Node or Bun system error carrying its errno `code`, such as ECONNREFUSED or Bun's ConnectionRefused. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

/** The HTTP status an error carries on `response.status`, as Keycloak admin-client errors do. */
export function errorResponseStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined
  const status = error.response.status
  return typeof status === 'number' ? status : undefined
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
