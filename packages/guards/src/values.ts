// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** A value that may be one string or a list of them, such as a JWT `aud` or a Keycloak attribute, as a list. */
export function stringList(value: unknown): string[] {
  return typeof value === 'string' ? [value] : stringArray(value) ?? []
}

/** Whether `value` is one of a closed set of literals, narrowing it to that union. */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((allowed) => allowed === value)
}
