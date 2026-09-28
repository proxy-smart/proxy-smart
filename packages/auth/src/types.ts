// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — Core Types
 *
 * All shared types for the SMART on FHIR authorization proxy.
 * Framework-agnostic. No runtime dependencies.
 */

// ─── Launch Session ─────────────────────────────────────────────────────────

/** Launch context resolved during the authorize flow, stored until token exchange */
export interface LaunchSession {
  /** Original redirect_uri from the client app (we replace it with our callback) */
  clientRedirectUri: string
  /** Original state param from the client */
  clientState: string
  /** Client ID from the authorize request */
  clientId: string
  /** Requested scopes (space-separated) */
  scope: string
  /** PKCE code_challenge (passthrough — we don't consume it) */
  codeChallenge?: string
  /** PKCE code_challenge_method */
  codeChallengeMethod?: string
  /** Resolved patient ID (set by EHR launch code or patient picker) */
  patient?: string
  /** Resolved encounter ID */
  encounter?: string
  /** FHIR user reference (e.g., "Practitioner/123") */
  fhirUser?: string
  /** Intent string */
  intent?: string
  /** SMART style URL */
  smartStyleUrl?: string
  /** Tenant identifier */
  tenant?: string
  /** Whether patient banner is needed */
  needPatientBanner?: boolean
  /** fhirContext array (JSON string) */
  fhirContext?: string
  /** Whether patient picker is required (standalone launch without pre-set context) */
  needsPatientPicker?: boolean
  /**
   * Launched from inside an EHR (a `launch` parameter resolved to context).
   *
   * Recorded because the launch KIND outlives the request that carried it, and the identity choice
   * at callback time needs it: an EHR launch means this human is here as a clinician.
   */
  ehrLaunch?: boolean
  /**
   * The OIDC `prompt` the client asked for.
   *
   * Kept so an interstitial can honour `prompt=none`, which says the client will accept no user
   * interaction at all (OIDC Core 3.1.2.6).
   */
  prompt?: string
  /**
   * Whether the human signing in has to say WHICH of their identities this launch is for.
   *
   * Set only when their Person links to more than one usable identity and the request did not
   * settle it — a clinician who also has a chart here, opening an app that asked for neither.
   */
  needsIdentityPicker?: boolean
  /**
   * The identity references that picker offered, e.g. `["Patient/1", "Practitioner/2"]`.
   *
   * Kept because the choice comes back in a form POST and must be checked against what was
   * actually offered. Derived from the signed-in human's own Person, so membership in this list
   * IS the authorization check — without it a session key would let anyone name any Practitioner
   * on the server and be issued a token as them.
   */
  identityOffered?: string[]
  /**
   * Set ONLY by the callback gate, once the user was established as a practitioner. The patient
   * search endpoint refuses without it, so a launch session alone does not open the directory.
   */
  pickerAllowed?: boolean
  /** The host could not identify the user at callback time; not the same as having no fhirUser. */
  identityUnresolved?: boolean
  /** FHIR server base URL from the aud/resource parameter (e.g., "https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4") */
  aud?: string
  /** IdP user subject (populated after IdP callback) */
  userSub?: string
  /** Timestamp when this session was created */
  createdAt: number
}

// ─── Launch Code ────────────────────────────────────────────────────────────

/** Payload embedded in the launch code JWT */
export interface LaunchCodePayload {
  /** Patient ID in context (FHIR resource ID, e.g., "Patient/123" or just "123") */
  patient?: string
  /** Encounter ID in context */
  encounter?: string
  /** FHIR user reference (e.g., "Practitioner/456") */
  fhirUser?: string
  /** Intent string (e.g., "order-review", "reconcile-medications") */
  intent?: string
  /** SMART style URL */
  smartStyleUrl?: string
  /** Tenant identifier */
  tenant?: string
  /** Whether patient banner is needed */
  needPatientBanner?: boolean
  /** fhirContext array (serialized as JSON string) */
  fhirContext?: string
  /** Target client_id this launch code is intended for (optional audience restriction) */
  clientId?: string
}

/** Result of verifying a launch code */
export interface LaunchCodeContext {
  payload: LaunchCodePayload
  /** Seconds until expiry */
  remainingTtl: number
}

// ─── Proxy Results ──────────────────────────────────────────────────────────

/** Result of a proxy handler — framework-agnostic response representation */
/**
 * Why an authorization was refused, when the OAuth `error` code alone is too coarse to
 * present. `access_denied` covers both "you are not a clinician" and "your account was
 * never linked to a patient record" — the second is an unfinished sign-up, and a host
 * that cannot tell them apart has to show the first message to both.
 */
export type SmartErrorReason =
  /** The signed-in account carries no `fhirUser` at all — sign-up never completed. */
  | 'account-not-linked'
  /** An identity exists but cannot be placed on a patient, and is not a practitioner. */
  | 'not-a-practitioner'

export type SmartProxyResult =
  | { type: 'redirect'; url: string }
  | { type: 'response'; status: number; body: unknown; headers?: Record<string, string> }
  | { type: 'error'; status: number; error: string; error_description: string; reason?: SmartErrorReason }

// ─── Authorize Request ──────────────────────────────────────────────────────

/** Parsed query parameters from an /authorize request */
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

// ─── Token Request / Response ───────────────────────────────────────────────

/** Parsed body from a /token request */
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

/** Decoded access token payload (minimal claims we inspect) */
export interface TokenPayload {
  sub?: string
  fhirUser?: string
  smart_scope?: string
  [key: string]: unknown
}

/** Token response enrichment data returned by the token enricher */
export interface TokenEnrichment {
  patient?: string
  encounter?: string
  fhirUser?: string
  intent?: string
  smart_style_url?: string
  tenant?: string
  need_patient_banner?: boolean
  fhirContext?: unknown
  scope?: string
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Configuration required by the SMART proxy */
export interface SmartProxyConfig {
  /** Base URL of this proxy (e.g., "https://auth.example.com") */
  baseUrl: string
  /** Path segment for the SMART callback (default: "/auth/smart-callback") */
  callbackPath?: string
  /** Secret for signing launch codes (HMAC-SHA256) */
  launchCodeSecret: string
  /** Launch code TTL in seconds (default: 300) */
  launchCodeTtlSeconds?: number
  /**
   * RFC 8707 resource URLs whose clients discovered THIS PROXY as their
   * authorization server, and for which the proxy must therefore own the
   * authorization response.
   *
   * A request naming one of these as its `resource` gets its callback intercepted
   * even when it carries no SMART scopes, so the redirect back to the client comes
   * from the proxy and can carry `iss` = {@link baseUrl}.
   *
   * WHY THIS EXISTS. MCP clients discover the authorization server via
   * `/.well-known/oauth-authorization-server`, where this proxy advertises
   * `issuer` = its own base URL because RFC 8414 §3.3 requires the issuer to match
   * the URL the document was fetched from. Without interception the IdP redirects
   * straight to the client and the response carries the IdP's `iss`
   * (`https://idp.example.com/realms/x`), which is not the recorded issuer. MCP
   * 2026-07-28 has clients compare the two with SIMPLE STRING COMPARISON and
   * forbids any normalization, so the mismatch is fatal — and it was invisible
   * before that revision, which did not mention RFC 9207 at all.
   *
   * SMART launches are intercepted regardless (they need launch context and the
   * patient picker), so this list only has to name the non-SMART resources.
   */
  interceptedResourceUrls?: string[]
}

// ─── Logger ─────────────────────────────────────────────────────────────────

/** Minimal logger interface — consumers inject their own */
export interface SmartProxyLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

/** No-op logger for when consumers don't need logging */
export const noopLogger: SmartProxyLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
