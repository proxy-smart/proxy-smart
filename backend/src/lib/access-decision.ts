// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { AccessControlResult } from './smart-access-control'

export const ACCESS_DENIED = 'access_denied'
export const INSUFFICIENT_SCOPE = 'insufficient_scope'

export interface Refusal {
  allowed: false
  status: number
  error: string
  message: string
}

export type AccessDecision<Grant extends object = object> = ({ allowed: true } & Grant) | Refusal

export function refusal(message: string, error: string = ACCESS_DENIED, status = 403): Refusal {
  return { allowed: false, status, error, message }
}

/** The upstream lookup a decision depends on failed, so it can neither grant nor refuse on the merits. */
export function upstreamUnverifiable(message: string): Refusal {
  return refusal(message, 'upstream_error', 502)
}

export function refusedResult({ status, error, message }: Refusal): AccessControlResult {
  return { allowed: false, status, body: { error, message } }
}
