// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { authorizeLaunchMint, type LaunchMintContext, type LaunchMintOutcome } from '@/lib/launch-authorization'
import { signLaunchCode, toLaunchCodeOptions, type LaunchCodePayload } from '@proxy-smart/auth'
import { smartProxyConfig, smartLogger } from '../smart-proxy-setup'

export type LaunchCaller =
  | { ok: true; caller: Record<string, unknown>; authHeader: string }
  | { ok: false; error: string; error_description: string }

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

export async function mintLaunchCode(
  caller: Record<string, unknown>,
  authHeader: string,
  context: LaunchMintContext,
): Promise<LaunchMintOutcome> {
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
    ...(context.clientId && { clientId: context.clientId }),
    ...(callerSub && { sub: callerSub }),
  }

  return {
    ok: true,
    launch: signLaunchCode(payload, toLaunchCodeOptions(smartProxyConfig, smartLogger)),
    expiresIn: config.smart.launchCodeTtlSeconds,
  }
}
