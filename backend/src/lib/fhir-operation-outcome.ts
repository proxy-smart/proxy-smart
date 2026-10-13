// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { isRecord } from './type-guards'

export type IssueSeverity = 'fatal' | 'error' | 'warning' | 'information'

export interface OperationOutcomeIssue {
  severity: IssueSeverity
  code: string
  diagnostics?: string
  expression?: string[]
}

const OperationOutcomeSchema = Type.Object({
  resourceType: Type.Literal('OperationOutcome'),
  issue: Type.Array(Type.Object({ diagnostics: Type.Optional(Type.String()) }, { additionalProperties: true })),
}, { additionalProperties: true })

type OperationOutcomeBody = Static<typeof OperationOutcomeSchema>

export function operationOutcome(
  code: string,
  diagnostics: string,
  options: { severity?: IssueSeverity; expression?: string[] } = {},
): { resourceType: 'OperationOutcome'; issue: OperationOutcomeIssue[] } {
  const issue: OperationOutcomeIssue = { severity: options.severity ?? 'error', code, diagnostics }
  if (options.expression) issue.expression = options.expression
  return { resourceType: 'OperationOutcome', issue: [issue] }
}

export function issueCodeForStatus(status: number): string {
  if (status === 401) return 'login'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 405 || status === 415) return 'not-supported'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 413) return 'too-costly'
  if (status >= 400 && status < 500) return 'invalid'
  return 'exception'
}

function isOperationOutcome(body: unknown): body is OperationOutcomeBody {
  return Value.Check(OperationOutcomeSchema, body)
}

/** The human-readable reason in a proxy refusal, whether it is an OperationOutcome or `{ error, message }`. */
export function refusalDiagnostics(body: unknown): string {
  if (isOperationOutcome(body)) {
    const text = body.issue.map((i) => i.diagnostics).filter(Boolean).join('; ')
    return text || 'Refused'
  }
  if (isRecord(body)) {
    if (typeof body.message === 'string') return body.message
    if (typeof body.error === 'string') return body.error
  }
  return typeof body === 'string' && body ? body : 'Refused'
}

export function toOperationOutcome(status: number, body: unknown): Record<string, unknown> {
  if (isOperationOutcome(body)) return body
  return operationOutcome(issueCodeForStatus(status), refusalDiagnostics(body))
}
