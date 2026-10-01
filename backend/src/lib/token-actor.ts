// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord } from './type-guards'

/**
 * RFC 8693 §4.1 actor chains for exchanged tokens. Keycloak's own delegation is
 * user-to-user and experimental, so the proxy records which client acted for whom.
 */

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'

export const MAX_ACTOR_DEPTH = 5

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

export interface TokenActor {
  client_id: string
  act?: TokenActor
}

export function sanitizeActor(value: unknown, depth = 1): TokenActor | undefined {
  if (depth > MAX_ACTOR_DEPTH || !isRecord(value)) return undefined
  const clientId = value.client_id
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) return undefined
  const inner = sanitizeActor(value.act, depth + 1)
  return inner ? { client_id: clientId, act: inner } : { client_id: clientId }
}

function clientOf(payload: Record<string, unknown>): string | undefined {
  const azp = payload.azp
  if (typeof azp === 'string' && azp) return azp
  const clientId = payload.client_id
  return typeof clientId === 'string' && clientId ? clientId : undefined
}

/** The act claim for a token `exchangingClient` obtained with `subject`, whose own chain is `subjectAct`. */
export function delegationActor(
  exchangingClient: string,
  subject: Record<string, unknown>,
  subjectAct?: TokenActor,
): TokenActor | null {
  const subjectClient = clientOf(subject)
  const prior = subjectAct ?? (subjectClient ? { client_id: subjectClient } : undefined)
  if (!prior) return null
  return sanitizeActor({ client_id: exchangingClient, act: prior }) ?? null
}

export function actorChain(actor: TokenActor | undefined): string[] {
  const chain: string[] = []
  for (let a = actor; a; a = a.act) chain.push(a.client_id)
  return chain
}
