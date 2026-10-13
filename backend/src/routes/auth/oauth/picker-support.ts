// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import fetch from 'cross-fetch'
import { logger } from '@/lib/logger'
import { getServerInfoByName } from '@/lib/fhir-server-store'
import { isRecord } from '@/lib/type-guards'
import type { LaunchSession, SmartProxyResult } from '@proxy-smart/auth'
import { smartStore } from '../smart-proxy-setup'

interface PickerError {
  ok: false
  status: number
  error: string
  error_description: string
}

type PickerOutcome<T> = { ok: true; value: T } | PickerError

const fail = (status: number, error: string, error_description: string): PickerError =>
  ({ ok: false, status, error, error_description })

export function pickerErrorBody(failure: PickerError): { error: string; error_description: string } {
  return { error: failure.error, error_description: failure.error_description }
}

export const SESSION_EXPIRED_DESCRIPTION = 'Session expired. Please restart the authorization flow.'

export function findPickerSession(sessionKey: unknown): PickerOutcome<{ key: string; session: LaunchSession }> {
  if (typeof sessionKey !== 'string' || !sessionKey) return fail(400, 'invalid_request', 'Missing session parameter')
  const session = smartStore.get(sessionKey)
  if (!session) return fail(401, 'session_expired', SESSION_EXPIRED_DESCRIPTION)
  return { ok: true, value: { key: sessionKey, session } }
}

/** Searches the upstream FHIR server behind the session's `aud`, the path both pickers read through. */
export async function searchPickerUpstream(
  aud: string | undefined,
  resourceType: string,
  params: Record<string, string>,
): Promise<PickerOutcome<{ status: number; body: string }>> {
  if (!aud) return fail(400, 'invalid_request', 'No FHIR server audience in session')

  const segments = new URL(aud).pathname.split('/').filter(Boolean)
  if (segments.length < 3) return fail(400, 'invalid_request', 'Cannot parse FHIR server from aud URL')

  const serverName = segments[segments.length - 2]
  const serverInfo = await getServerInfoByName(serverName)
  if (!serverInfo) return fail(404, 'server_not_found', `FHIR server '${serverName}' not found`)

  const upstreamUrl = new URL(`${serverInfo.url}/${resourceType}`)
  for (const [key, value] of Object.entries(params)) upstreamUrl.searchParams.set(key, value)

  try {
    const res = await fetch(upstreamUrl.href, { headers: { Accept: 'application/fhir+json' } })
    return { ok: true, value: { status: res.status, body: await res.text() } }
  } catch (err) {
    logger.auth.error('Picker search proxy failed', {
      resourceType,
      error: err instanceof Error ? err.message : String(err),
    })
    return fail(502, 'upstream_error', 'Failed to reach FHIR server')
  }
}

export function resourceIdsInBundle(body: string, resourceType: string): string[] {
  let bundle: unknown
  try {
    bundle = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRecord(bundle) || !Array.isArray(bundle.entry)) return []
  return bundle.entry.flatMap((entry: unknown) => {
    const resource = isRecord(entry) ? entry.resource : undefined
    return isRecord(resource) && resource.resourceType === resourceType && typeof resource.id === 'string'
      ? [resource.id]
      : []
  })
}

/** Picker submissions: a JSON caller gets the next URL in the body, a form post gets a 302. */
export function pickerSubmissionResponse(result: SmartProxyResult, contentType: string | undefined): Response {
  switch (result.type) {
    case 'redirect':
      return contentType?.includes('application/json')
        ? Response.json({ redirect_url: result.url })
        : new Response(null, { status: 302, headers: { Location: result.url } })
    case 'error':
      return Response.json({ error: result.error, error_description: result.error_description }, { status: result.status })
    case 'response':
      return Response.json(result.body, { status: result.status, headers: result.headers })
  }
}
