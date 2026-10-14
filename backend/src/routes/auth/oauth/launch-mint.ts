// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Context } from 'elysia'
import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { authorizeLaunchMint, type LaunchMintContext, type LaunchMintOutcome } from '@/lib/launch-authorization'
import { checkEncounterOfPatient, type ResourceRead } from '@/lib/launch-encounter'
import { fhirResourceUrlFor, type FHIRServerInfo } from '@/lib/fhir-server-store'
import { isRecord } from '@/lib/type-guards'
import { fhirContextIssues, signLaunchCode, toLaunchCodeOptions, type LaunchCodePayload } from '@proxy-smart/auth'
import { smartProxyConfig, smartLogger } from '../smart-proxy-setup'
import { findFhirServerForBase } from './shared'

export type LaunchCaller =
  | { ok: true; caller: Record<string, unknown>; authHeader: string }
  | { ok: false; error: string; error_description: string }

type MintFailure = Extract<LaunchMintOutcome, { ok: false }>

const invalid = (error_description: string): MintFailure => ({ ok: false, status: 400, error: 'invalid_request', error_description })

export async function authenticateLaunchCaller(authHeader: string | undefined): Promise<LaunchCaller> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'unauthorized', error_description: 'Bearer token required to issue launch codes' }
  }
  try {
    return { ok: true, caller: await validateToken(authHeader.slice(7)), authHeader }
  } catch {
    return { ok: false, error: 'unauthorized', error_description: 'Invalid or expired Bearer token' }
  }
}

function failureDetail(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error
  if (isRecord(body) && Array.isArray(body.issue)) {
    const diagnostics = body.issue.flatMap((issue) => (isRecord(issue) && typeof issue.diagnostics === 'string' ? [issue.diagnostics] : []))
    if (diagnostics.length > 0) return diagnostics.join('; ')
  }
  return `HTTP ${status}`
}

/** A read through the proxy's own FHIR path, with the caller's token, so every FHIR access rule applies. */
export async function readThroughProxy(info: FHIRServerInfo, type: string, id: string, authHeader: string): Promise<ResourceRead> {
  const { proxyFHIR } = await import('@/routes/fhir')
  const set: Context['set'] = { headers: {} }
  const path = `/${config.name}/${info.identifier}/${info.metadata.fhirVersion}/${type}/${encodeURIComponent(id)}`
  const body = await proxyFHIR({
    params: { server_name: info.identifier, fhir_version: info.metadata.fhirVersion },
    request: new Request(new URL(path, config.baseUrl), {
      headers: { authorization: authHeader, accept: 'application/fhir+json' },
    }),
    set,
  })

  const status = set.status === undefined ? 200 : typeof set.status === 'number' ? set.status : 502
  if (status >= 400) return { ok: false, status, detail: failureDetail(body, status) }
  if (!isRecord(body)) return { ok: false, status: 502, detail: 'the FHIR server did not answer with a resource' }
  return { ok: true, resource: body }
}

/** The SMART rules on launch context that need no FHIR read: fhirContext shape and a known iss. */
async function launchServer(context: LaunchMintContext): Promise<{ ok: true; server: FHIRServerInfo | null } | MintFailure> {
  const issues = fhirContextIssues(context.fhirContext ?? [])
  if (issues.length > 0) return invalid(`fhirContext does not follow SMART App Launch: ${issues.join('; ')}`)
  if (!context.fhirBase) return { ok: true, server: null }
  const server = await findFhirServerForBase(context.fhirBase)
  return server ? { ok: true, server } : invalid(`iss ${context.fhirBase} is not the base of a FHIR server on this proxy`)
}

export async function mintLaunchCode(
  caller: Record<string, unknown>,
  authHeader: string,
  context: LaunchMintContext,
): Promise<LaunchMintOutcome> {
  const target = await launchServer(context)
  if (!target.ok) return target

  const decision = await authorizeLaunchMint(caller, { patient: context.patient, fhirUser: context.fhirUser }, authHeader)
  if (!decision.allowed) {
    smartLogger.warn('Launch code refused', { reason: decision.reason, clientId: context.clientId })
    return {
      ok: false,
      status: 403,
      error: 'access_denied',
      error_description: `You are not allowed to issue a launch code for this context: ${decision.reason}`,
    }
  }

  const { server } = target
  if (server && context.patient && context.encounter) {
    const bases = { fhirBase: fhirResourceUrlFor(server), url: server.url }
    const check = await checkEncounterOfPatient(context.patient, context.encounter, bases, (type, id) => readThroughProxy(server, type, id, authHeader))
    if (!check.ok) return check
  }

  const callerSub = typeof caller.sub === 'string' ? caller.sub : undefined
  const payload: LaunchCodePayload = {
    ...(context.patient && { patient: context.patient }),
    ...(context.encounter && { encounter: context.encounter }),
    ...(context.fhirUser && { fhirUser: context.fhirUser }),
    ...(context.intent && { intent: context.intent }),
    ...(context.smartStyleUrl && { smartStyleUrl: context.smartStyleUrl }),
    ...(context.tenant && { tenant: context.tenant }),
    ...(context.needPatientBanner !== undefined && { needPatientBanner: context.needPatientBanner }),
    ...(context.fhirContext && { fhirContext: JSON.stringify(context.fhirContext) }),
    ...(context.appContext !== undefined && { appContext: context.appContext }),
    clientId: context.clientId,
    ...(context.fhirBase && { fhirBase: context.fhirBase }),
    ...(callerSub && { sub: callerSub }),
  }

  return {
    ok: true,
    launch: signLaunchCode(payload, toLaunchCodeOptions(smartProxyConfig, smartLogger)),
    expiresIn: config.smart.launchCodeTtlSeconds,
  }
}
