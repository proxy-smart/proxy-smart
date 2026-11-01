// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from '../logger'
import { refusedResult, type Refusal } from '../access-decision'
import type { AccessControlContext, AccessControlResult } from '../smart-access-control'

/** The patient id of a `Patient/<id>` compartment. */
export function compartmentPatientId(compartment: string): string {
  return compartment.split('/')[1] ?? ''
}

/** Logs a request outside the compartment; refuses it when enforcing, else lets it through unchanged. */
export function outsideCompartment(
  kind: 'Read' | 'Write',
  ctx: AccessControlContext,
  compartment: string,
  queryString: string,
  decision: Refusal,
  refuse: boolean,
): AccessControlResult {
  logger.fhir.warn(`${kind} outside the patient compartment`, {
    compartment,
    method: ctx.method,
    resourcePath: ctx.resourcePath,
    reason: decision.message,
    server: ctx.serverName,
    wouldDeny: !refuse,
  })
  return refuse ? refusedResult(decision) : { allowed: true, modifiedQueryString: queryString }
}
