// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Launch context resolved during the authorize flow, stored until token exchange */
export interface LaunchSession {
  /** The client's own redirect_uri; the IdP is sent the proxy callback instead */
  clientRedirectUri: string
  clientState: string
  clientId: string
  /** Space-separated */
  scope: string
  /** Passthrough, the proxy does not consume it */
  codeChallenge?: string
  codeChallengeMethod?: string
  patient?: string
  encounter?: string
  /** e.g. "Practitioner/123" */
  fhirUser?: string
  intent?: string
  smartStyleUrl?: string
  tenant?: string
  needPatientBanner?: boolean
  /** JSON string */
  fhirContext?: string
  /** Returned as is in the token response */
  appContext?: string
  /** A patient still has to be established: the request needs one and no launch code supplied it */
  needsPatientPicker?: boolean
  /** Standalone `launch/encounter`: an encounter of the patient in context is still to be chosen. */
  needsEncounterPicker?: boolean
  /** Encounter ids the encounter picker offered; a submitted choice must be one of them. */
  encounterOffered?: string[]
  /** Subject the resolved launch code was issued to; its context applies only to that user. */
  launchSub?: string
  /** SHA-256 of the authorization code the callback forwarded; the token exchange matches on it. */
  authCodeHash?: string
  /** EHR launch; the callback identity choice treats the user as a clinician. */
  ehrLaunch?: boolean
  /** Kept so an interstitial can honour `prompt=none` (OIDC Core 3.1.2.6). */
  prompt?: string
  /** The user's Person links to several usable identities and the request did not settle which. */
  needsIdentityPicker?: boolean
  /** Identities the picker offered; membership IS the authorization check for the POSTed choice. */
  identityOffered?: string[]
  /** Set ONLY by the callback gate for a practitioner; the patient search endpoint refuses without it. */
  pickerAllowed?: boolean
  /** The host could not identify the user at callback time; not the same as having no fhirUser. */
  identityUnresolved?: boolean
  /** FHIR server base URL from the aud/resource parameter */
  aud?: string
  /** Populated after the IdP callback */
  userSub?: string
  createdAt: number
}

/** Payload embedded in the launch code JWT */
export interface LaunchCodePayload {
  /** "Patient/123" or just "123" */
  patient?: string
  encounter?: string
  fhirUser?: string
  intent?: string
  smartStyleUrl?: string
  tenant?: string
  needPatientBanner?: boolean
  /** JSON string */
  fhirContext?: string
  /** CDS Hooks Link / SMART task-ehr-launch, opaque to the proxy */
  appContext?: string
  /** The client this launch code is for; authorize refuses a code bound to no client or another one. */
  clientId?: string
  /** Subject of the user the launch code was issued to; its context applies only to that user. */
  sub?: string
  /** The FHIR base (the launch `iss`) the code was minted for; the app's `aud` must name it. */
  fhirBase?: string
}

export interface LaunchCodeContext {
  payload: LaunchCodePayload
  /** Seconds */
  remainingTtl: number
  /** Spent by the code's first authorization request */
  jti?: string
  /** Epoch milliseconds */
  expiresAt?: number
}

export type SmartProxyResult =
  | { type: 'redirect'; url: string }
  | { type: 'response'; status: number; body: unknown; headers?: Record<string, string> }
  | { type: 'error'; status: number; error: string; error_description: string }

export interface AuthorizeParams {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  scope?: string
  state?: string
  code_challenge?: string
  code_challenge_method?: string
  aud?: string
  resource?: string
  launch?: string
  [key: string]: string | undefined
}

export interface TokenRequestParams {
  grant_type?: string
  code?: string
  redirect_uri?: string
  client_id?: string
  client_secret?: string
  code_verifier?: string
  refresh_token?: string
  scope?: string
  [key: string]: string | undefined
}

export interface TokenPayload {
  sub?: string
  fhirUser?: string
  [key: string]: unknown
}

export interface TokenEnrichment {
  patient?: string
  encounter?: string
  fhirUser?: string
  intent?: string
  smart_style_url?: string
  tenant?: string
  need_patient_banner?: boolean
  fhirContext?: unknown
  appContext?: string
}

export interface SmartProxyConfig {
  baseUrl: string
  /** Default "/auth/smart-callback" */
  callbackPath?: string
  /** HMAC-SHA256 key for launch codes */
  launchCodeSecret: string
  /** Seconds, default 300 */
  launchCodeTtlSeconds?: number
  /**
   * Non-SMART RFC 8707 resources whose callback the proxy intercepts so the redirect carries `iss` = baseUrl.
   * MCP 2026-07-28 compares `iss` to the RFC 8414 issuer by exact string match (RFC 9207).
   */
  interceptedResourceUrls?: string[]
}

export interface SmartProxyLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const noopLogger: SmartProxyLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
