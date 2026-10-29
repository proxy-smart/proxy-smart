// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseTokenScopes } from '@proxy-smart/auth'
import { resolveTokenPatient } from '../patient-context'
import { tokenContextStore } from '../token-context-store'
import { stringList } from '../type-guards'
import { splitReference, trimTrailingSlash } from './resource'

export interface AppStateFhirServer {
  base: string
  upstream: string
}

export interface AppStateCaller {
  clientId: string
  scopes: ReadonlySet<string>
  patient: string | null
  users: readonly string[]
  unbound: string | null
}

function stringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value ? value : undefined
}

function serverBase(url: string, servers: readonly AppStateFhirServer[]): string | null {
  const wanted = trimTrailingSlash(url)
  const server = servers.find((s) => trimTrailingSlash(s.base) === wanted || trimTrailingSlash(s.upstream) === wanted)
  return server ? trimTrailingSlash(server.base) : null
}

export function tokenServerBases(aud: unknown, servers: readonly AppStateFhirServer[]): string[] {
  const named = new Set(stringList(aud).map((value) => serverBase(value, servers)).filter((base) => base !== null))
  if (named.size === 0 && servers.length === 1) return [trimTrailingSlash(servers[0].base)]
  return [...named]
}

function bind(reference: string, contextBase: string | null, servers: readonly AppStateFhirServer[]): string | null {
  const split = splitReference(reference)
  if (!split) return null
  const base = split.base === null ? contextBase : serverBase(split.base, servers)
  return base ? `${base}/${split.relative}` : null
}

function unboundReason(bases: readonly string[]): string | null {
  if (bases.length === 1) return null
  return bases.length > 1
    ? 'The access token names several FHIR servers, so its patient and user context is ambiguous'
    : 'The access token does not name the FHIR server its patient and user context belongs to'
}

export async function callerFromToken(payload: Record<string, unknown>, servers: readonly AppStateFhirServer[]): Promise<AppStateCaller> {
  const clientId = stringClaim(payload, 'azp') ?? stringClaim(payload, 'client_id') ?? ''
  const bases = tokenServerBases(payload.aud, servers)
  const contextBase = bases.length === 1 ? bases[0] : null

  const resolved = await resolveTokenPatient(payload)
  const patientRef = resolved ? (resolved.patient.includes('/') ? resolved.patient : `Patient/${resolved.patient}`) : null

  const jti = stringClaim(payload, 'jti')
  const issued = jti ? (await tokenContextStore.get(jti, clientId || undefined))?.fhirUser : undefined
  const users = [issued, stringClaim(payload, 'fhirUser')]
    .map((ref) => (ref ? bind(ref, contextBase, servers) : null))
    .filter((ref) => ref !== null)

  return {
    clientId,
    scopes: parseTokenScopes(payload),
    patient: patientRef ? bind(patientRef, contextBase, servers) : null,
    users: [...new Set(users)],
    unbound: unboundReason(bases),
  }
}
