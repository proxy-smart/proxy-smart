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
import { hashAuthCode } from './auth-code'

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
  /** The authorization code being exchanged; a refresh carries none and matches no session */
  code?: string
  /** Granted scope string (from IdP response or request) */
  grantedScope?: string
}

/** The launch session a token exchange belongs to, found by the authorization code it carries. */
function findCodeSession(
  store: ILaunchContextStore,
  clientId: string | undefined,
  clientRedirectUri: string | undefined,
  code: string | undefined,
): [string, LaunchSession] | null {
  if (!clientId || !code) return null
  const codeHash = hashAuthCode(code)
  return store.find(
    s => s.authCodeHash === codeHash && s.clientId === clientId
      && (!clientRedirectUri || s.clientRedirectUri === clientRedirectUri),
  )
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

  // ── Session lookup by the authorization code being exchanged ──────────
  let sessionContext: LaunchSession | null = null
  {
    const found = findCodeSession(store, input.clientId, input.redirectUri, input.code)
    if (found) {
      const [key, session] = found
      store.delete(key) // Consume — single use
      const launchUser = session.launchSub
      if (launchUser && launchUser !== input.tokenPayload.sub) {
        logger?.warn('Token enrichment: launch context issued to a different user, not applied', {
          key: key.slice(0, 8) + '...',
          clientId: session.clientId,
        })
      } else {
        sessionContext = session
        logger?.info('Token enrichment: resolved session context', {
          key: key.slice(0, 8) + '...',
          patient: session.patient,
          encounter: session.encounter,
          clientId: session.clientId,
        })
      }
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
  code: string | undefined,
  deps: TokenEnricherDeps,
): string | null {
  if (!clientRedirectUri) return null

  const { store, config, logger } = deps
  const callbackPath = config.callbackPath ?? DEFAULT_CALLBACK_PATH

  const matchingSession = findCodeSession(store, clientId, clientRedirectUri, code)

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
  code: string | undefined,
  deps: TokenEnricherDeps,
): string | null {
  if (!clientRedirectUri) return null
  const match = findCodeSession(deps.store, clientId, clientRedirectUri, code)
  if (!match) return null
  const [, session] = match
  return session.aud ?? null
}
