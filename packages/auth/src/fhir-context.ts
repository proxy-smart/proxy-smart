// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The one relative role SMART defines; any other role is an absolute URI. */
export const LAUNCH_ROLE = 'launch'

/** Kept in the top-level `patient` and `encounter` parameters rather than in fhirContext. */
const TOP_LEVEL_TYPES = new Set(['Patient', 'Encounter'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbsoluteUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
}

function referencedType(reference: unknown): string | undefined {
  if (typeof reference !== 'string') return undefined
  const segments = reference.split(/[?#]/, 1)[0].split('/').filter(Boolean)
  const historyAt = segments.indexOf('_history')
  const typed = historyAt > 0 ? segments.slice(0, historyAt) : segments
  return typed.length >= 2 ? typed[typed.length - 2] : undefined
}

function itemIssues(item: unknown, at: string): string[] {
  if (!isRecord(item)) return [`${at} must be an object`]
  const issues: string[] = []

  const hasTarget = typeof item.reference === 'string' || typeof item.canonical === 'string' || isRecord(item.identifier)
  if (!hasTarget) issues.push(`${at} must include reference, canonical or identifier`)

  const role = item.role
  if (role !== undefined && (typeof role !== 'string' || role === '')) {
    issues.push(`${at}.role may be omitted but must not be empty`)
  } else if (typeof role === 'string' && role !== LAUNCH_ROLE && !isAbsoluteUri(role)) {
    issues.push(`${at}.role must be an absolute URI unless it is the SMART-defined "${LAUNCH_ROLE}"`)
  }

  const type = typeof item.type === 'string' ? item.type : referencedType(item.reference)
  if (type && TOP_LEVEL_TYPES.has(type) && (role === undefined || role === LAUNCH_ROLE)) {
    issues.push(`${at} is a ${type}, which belongs in the top-level ${type.toLowerCase()} parameter unless it carries a role other than "${LAUNCH_ROLE}"`)
  }
  return issues
}

/** Every way a fhirContext array departs from SMART App Launch 2.2 (scopes-and-launch-context). */
export function fhirContextIssues(items: readonly unknown[]): string[] {
  return items.flatMap((item, index) => itemIssues(item, `fhirContext[${index}]`))
}
