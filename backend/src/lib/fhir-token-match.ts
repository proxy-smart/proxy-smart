// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord, optionalString } from './type-guards'

/** Token search parameters evaluable on a resource body, mapped to the element they search. */
const LOCAL_TOKEN_PARAMS: Readonly<Record<string, string>> = {
  category: 'category',
  code: 'code',
  status: 'status',
  'clinical-status': 'clinicalStatus',
  'verification-status': 'verificationStatus',
  intent: 'intent',
  type: 'type',
  class: 'class',
  identifier: 'identifier',
  gender: 'gender',
  priority: 'priority',
  criticality: 'criticality',
}

interface TokenCandidate {
  system: string | undefined
  code: string
  primitive: boolean
}

interface TokenQuery {
  system: string | undefined
  code: string | undefined
  hasSystemPart: boolean
}

function splitOnUnescaped(value: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1]
      i++
    } else if (ch === separator) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

function unescape(value: string): string | undefined {
  return value ? value.replace(/\\(.)/g, '$1') : undefined
}

function parseTokenQuery(value: string): TokenQuery {
  const pipe = splitOnUnescaped(value, '|')
  if (pipe.length < 2) return { system: undefined, code: unescape(value), hasSystemPart: false }
  const [system, ...rest] = pipe
  return { system: unescape(system), code: unescape(rest.join('|')), hasSystemPart: true }
}

function candidatesOf(value: unknown): TokenCandidate[] {
  if (Array.isArray(value)) return value.flatMap(candidatesOf)
  if (typeof value === 'string') return [{ system: undefined, code: value, primitive: true }]
  if (typeof value === 'boolean') return [{ system: undefined, code: String(value), primitive: true }]
  if (!isRecord(value)) return []
  if (Array.isArray(value.coding)) return value.coding.flatMap(candidatesOf)
  const code = optionalString(value.code) ?? optionalString(value.value)
  return code === undefined ? [] : [{ system: optionalString(value.system), code, primitive: false }]
}

function candidateMatches(candidate: TokenCandidate, query: TokenQuery): boolean {
  if (candidate.primitive) return !query.hasSystemPart && candidate.code === query.code
  if (!query.hasSystemPart) return candidate.code === query.code
  if (query.system === undefined) return candidate.system === undefined && candidate.code === query.code
  if (candidate.system !== query.system) return false
  return query.code === undefined || candidate.code === query.code
}

/** Whether the parameter can be evaluated locally at all (no modifiers, chains or unknown params). */
export function isLocallyEvaluable(param: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_TOKEN_PARAMS, param)
}

/**
 * FHIR token search semantics on a resource body: `[code]`, `[system]|[code]`, `|[code]`
 * and `[system]|`, with `,` as OR. Undefined when the parameter is not locally evaluable.
 */
export function resourceMatchesToken(resource: Record<string, unknown>, param: string, value: string): boolean | undefined {
  if (!isLocallyEvaluable(param)) return undefined
  const candidates = candidatesOf(resource[LOCAL_TOKEN_PARAMS[param]])
  return splitOnUnescaped(value, ',')
    .map(parseTokenQuery)
    .some((query) => candidates.some((candidate) => candidateMatches(candidate, query)))
}
