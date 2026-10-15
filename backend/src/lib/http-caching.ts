// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createHash } from 'crypto'

function directives(cacheControl: string): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const part of cacheControl.split(',')) {
    const [rawName, ...rest] = part.split('=')
    const name = rawName.trim().toLowerCase()
    if (name) parsed.set(name, rest.join('=').trim().replace(/^"(.*)"$/, '$1'))
  }
  return parsed
}

function seconds(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  return Number(value)
}

/** How long a response may be reused (RFC 9111 §5.2.2), as a cache that is shared across users. */
export function cacheLifetimeMs(cacheControl: string | null | undefined, fallbackMs: number, ceilingMs: number): number {
  if (!cacheControl) return fallbackMs
  const parsed = directives(cacheControl)
  if (parsed.has('no-store') || parsed.has('no-cache')) return 0
  const lifetime = seconds(parsed.get('s-maxage')) ?? seconds(parsed.get('max-age'))
  if (lifetime === null) return fallbackMs
  return Math.min(lifetime * 1000, ceilingMs)
}

/** A weak validator derived from the representation, so equal content always yields the same tag. */
export function weakEtag(content: string): string {
  return `W/"${createHash('sha256').update(content).digest('base64url')}"`
}

/** Union of Vary field lists, case-insensitively deduplicated; `*` absorbs everything (RFC 9110 §12.5.5). */
export function mergeVary(...values: (string | null | undefined)[]): string {
  const fields = new Map<string, string>()
  for (const field of values.flatMap(value => value?.split(',') ?? [])) {
    const name = field.trim()
    if (name === '*') return '*'
    if (name && !fields.has(name.toLowerCase())) fields.set(name.toLowerCase(), name)
  }
  return [...fields.values()].join(', ')
}

const opaqueTag = (etag: string): string => etag.trim().replace(/^W\//, '')

/** RFC 9110 §13.1.2: weak comparison against any listed tag, or `*`. */
export function ifNoneMatchSatisfied(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === '*') return true
  const current = opaqueTag(etag)
  return ifNoneMatch.split(',').some((candidate) => opaqueTag(candidate) === current)
}
