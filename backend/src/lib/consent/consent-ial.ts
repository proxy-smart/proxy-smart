// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ConsentCheckContextWithIal, ConsentCheckResultWithIal, SmartTokenPayload } from './types'
import { buildConsentContext, checkConsent, getConsentConfig, logAuditEntry, tokenIdentity } from './consent-service'
import { checkIal, getIalConfig } from './person-resolver'

/**
 * Build enhanced consent context with IAL info
 */
export async function buildConsentContextWithIal(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  resourcePath: string,
  method: string
): Promise<ConsentCheckContextWithIal> {
  const baseContext = await buildConsentContext(tokenPayload, serverName, resourcePath, method)
  const ialConfig = getIalConfig()

  return {
    ...baseContext,
    ialEnabled: ialConfig.enabled,
    ialMinimumLevel: ialConfig.minimumLevel,
    isSensitiveResource: ialConfig.enabled &&
      baseContext.resourceType !== null &&
      ialConfig.sensitiveResourceTypes.includes(baseContext.resourceType),
    // Populated after the IAL check.
    assuranceLevel: null,
    assuranceLevelNumeric: null,
    patientLinkVerified: false,
    personId: null
  }
}

/**
 * Consent and IAL check in sequence: IAL first (when enabled, Person→Patient link and
 * assurance level), then consent, returning the combined decision.
 */
export async function checkConsentWithIal(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  resourcePath: string,
  method: string,
  authHeader: string
): Promise<ConsentCheckResultWithIal> {
  const startTime = performance.now()
  const consentConfig = getConsentConfig()
  const ialConfig = getIalConfig()
  const context = await buildConsentContextWithIal(tokenPayload, serverName, resourcePath, method)
  const { userId, username } = tokenIdentity(tokenPayload)

  let ialCheckResult = null
  if (ialConfig.enabled) {
    ialCheckResult = await checkIal(tokenPayload, serverName, serverUrl, context.resourceType, authHeader)

    if (!ialCheckResult.allowed) {
      const result: ConsentCheckResultWithIal = {
        decision: 'deny',
        consentId: null,
        reason: `IAL verification failed: ${ialCheckResult.reason}`,
        cached: false,
        checkDurationMs: performance.now() - startTime,
        context,
        ialCheck: ialCheckResult
      }

      logAuditEntry({
        timestamp: new Date().toISOString(),
        decision: result.decision,
        consentId: null,
        patientId: context.patientId,
        clientId: context.clientId,
        userId,
        username,
        resourceType: context.resourceType,
        resourcePath: context.resourcePath,
        serverName: context.serverName,
        method: context.method,
        scopes: context.scopes,
        reason: result.reason,
        mode: consentConfig.mode,
        enforced: consentConfig.mode === 'enforce',
        ialCheck: ialCheckResult
      }, { cached: false, checkDurationMs: result.checkDurationMs })

      return result
    }
  }

  const consentResult = await checkConsent(tokenPayload, serverName, serverUrl, resourcePath, method, authHeader)

  const combinedResult: ConsentCheckResultWithIal = {
    ...consentResult,
    context,
    ialCheck: ialCheckResult
  }

  if (ialCheckResult && consentResult.decision === 'permit') {
    combinedResult.reason = `${consentResult.reason} (IAL: ${ialCheckResult.actualLevel ?? 'n/a'})`
  }

  combinedResult.checkDurationMs = performance.now() - startTime

  return combinedResult
}
