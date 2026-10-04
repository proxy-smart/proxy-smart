// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — Token Enricher
 *
 * After the IdP returns a token response, enriches it with SMART launch context:
 *   - Session-based context (EHR launch / patient picker)
 *   - fhirUser derivation from token claims
 *   - Scope-gated output per SMART 2.2.0 Section 2.0.7
 */

import type {
  LaunchSession,
  SmartProxyConfig,
  SmartProxyLogger,
  TokenEnrichment,
  TokenPayload,
} from './types'
import type { ILaunchContextStore } from './stores/interface'
import {
  canReturnPatient,
  canReturnEncounter,
  parseScopes,
} from './smart-scopes'
import { extractPatientFromFhirUser } from './fhir-user'
import { DEFAULT_CALLBACK_PATH } from './redirect-uri'

export interface TokenEnricherDeps {
  config: SmartProxyConfig
  store: ILaunchContextStore
  logger?: SmartProxyLogger
}

export interface TokenEnrichInput {
  /** Decoded access token payload */
  tokenPayload: TokenPayload
  /** The client_id from the token request */
  clientId?: string
  /** The redirect_uri from the token request */
  redirectUri?: string
  /** Granted scope string (from IdP response or request) */
  grantedScope?: string
}

/**
 * Enrich a token response with SMART launch context.
 *
 * Looks up the session store, applies scope-gated enrichment, and consumes the session.
 * Returns only the enrichment fields to add to the token response — the caller merges them.
 */
export function enrichTokenResponse(
  input: TokenEnrichInput,
  deps: TokenEnricherDeps,
): TokenEnrichment {
  const { store, logger } = deps
  const enrichment: TokenEnrichment = {}

  const grantedScopes = parseScopes(input.grantedScope)

  // ── Session lookup by client_id + redirect_uri ────────────────────────
  let sessionContext: LaunchSession | null = null
  if (input.clientId && input.redirectUri) {
    const found = store.find(
      s => s.clientId === input.clientId && s.clientRedirectUri === input.redirectUri
    )
    if (found) {
      const [key, session] = found
      sessionContext = session
      store.delete(key) // Consume — single use
      logger?.info('Token enrichment: resolved session context', {
        key: key.slice(0, 8) + '...',
        patient: session.patient,
        encounter: session.encounter,
        clientId: session.clientId,
      })
    }
  }

  // ── Apply session context (priority source) ───────────────────────────
  if (sessionContext) {
    if (sessionContext.patient && canReturnPatient(grantedScopes)) {
      // SMART STU 2.2 §2.0.13: patient context is the logical ID only (no resource type prefix)
      enrichment.patient = sessionContext.patient.replace(/^Patient\//, '')
    }
    if (sessionContext.encounter && canReturnEncounter(grantedScopes)) {
      // SMART STU 2.2: encounter context is the logical ID only
      enrichment.encounter = sessionContext.encounter.replace(/^Encounter\//, '')
    }
    if (sessionContext.intent) {
      enrichment.intent = sessionContext.intent
    }
    if (sessionContext.smartStyleUrl) {
      enrichment.smart_style_url = sessionContext.smartStyleUrl
    }
    if (sessionContext.tenant) {
      enrichment.tenant = sessionContext.tenant
    }
    if (sessionContext.needPatientBanner !== undefined) {
      enrichment.need_patient_banner = sessionContext.needPatientBanner
    }
    if (sessionContext.fhirContext) {
      try {
        enrichment.fhirContext = JSON.parse(sessionContext.fhirContext)
      } catch { /* ignore parse errors */ }
    }
  }

  // ── Derive patient from fhirUser (spec-compliant fallback) ────────────
  if (!enrichment.patient && canReturnPatient(grantedScopes)) {
    const fhirUser = input.tokenPayload.fhirUser
    if (fhirUser) {
      const patientId = extractPatientFromFhirUser(fhirUser)
      if (patientId) enrichment.patient = patientId
    }
  }

  // ── Scope passthrough ─────────────────────────────────────────────────
  // Keycloak now has granular scopes registered (auto-created by admin API),
  // so the token scope already matches what the client requested. No restoration needed.
  if (input.tokenPayload.smart_scope) {
    enrichment.scope = input.tokenPayload.smart_scope
  }

  return enrichment
}

/**
 * Rewrite the redirect_uri for the IdP token exchange.
 *
 * When the proxy intercepted the callback, the IdP expects OUR callback URI,
 * not the client's. This function checks if a session exists and returns
 * the rewritten URI, or null if no rewrite is needed.
 */
export function getRewrittenRedirectUri(
  clientId: string | undefined,
  clientRedirectUri: string | undefined,
  deps: TokenEnricherDeps,
): string | null {
  if (!clientId || !clientRedirectUri) return null

  const { store, config, logger } = deps
  const callbackPath = config.callbackPath ?? DEFAULT_CALLBACK_PATH

  const matchingSession = store.find(
    s => s.clientId === clientId && s.clientRedirectUri === clientRedirectUri
  )

  if (matchingSession) {
    const proxyCallbackUri = `${config.baseUrl}${callbackPath}`
    logger?.debug('Token: rewrote redirect_uri for SMART session', {
      original: clientRedirectUri,
      rewritten: proxyCallbackUri,
    })
    return proxyCallbackUri
  }

  return null
}

/**
 * Resolve the requested resource audience captured for a SMART session at the
 * token endpoint, so it can be re-sent to Keycloak as the RFC 8707 `resource`
 * parameter (must match the value sent at /authorize, else Keycloak returns
 * invalid_target / not-matching). Returns null when no SMART session matches or
 * the session carried no aud.
 */
export function getSessionAudience(
  clientId: string | undefined,
  clientRedirectUri: string | undefined,
  deps: TokenEnricherDeps,
): string | null {
  if (!clientId || !clientRedirectUri) return null
  const { store } = deps
  const match = store.find(
    s => s.clientId === clientId && s.clientRedirectUri === clientRedirectUri,
  )
  if (!match) return null
  const [, session] = match
  return session.aud ?? null
}
