// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth
 *
 * SMART on FHIR STU 2.2.0 server-side authorization proxy library.
 * Framework-agnostic, IdP-pluggable.
 *
 * @example
 * ```ts
 * import {
 *   handleAuthorize,
 *   handleCallback,
 *   handlePatientSelect,
 *   handleIdentitySelect,
 *   enrichTokenResponse,
 *   enrichIntrospection,
 *   getRewrittenRedirectUri,
 *   MemoryStore,
 *   KeycloakAdapter,
 *   signLaunchCode,
 *   verifyLaunchCode,
 * } from '@proxy-smart/auth'
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  LaunchSession,
  LaunchCodePayload,
  LaunchCodeContext,
  SmartProxyResult,
  SmartErrorReason,
  AuthorizeParams,
  TokenRequestParams,
  TokenPayload,
  TokenEnrichment,
  SmartProxyConfig,
  SmartProxyLogger,
} from './types'
export { noopLogger } from './types'

// ─── Smart Scopes ───────────────────────────────────────────────────────────
export {
  parseScopes,
  parseTokenScopes,
  isSmartLaunch,
  isStandaloneLaunch,
  canReturnPatient,
  canReturnEncounter,
  canReturnFhirUser,
  isScopeGranted,
  filterScopes,
  expandScopesToWildcards,
  hasPatientCompartmentScope,
  hasUserLevelScope,
  USER_LEVEL_SCOPE_RE,
  SMART_V2_SCOPE_RE,
  PATIENT_COMPARTMENT_SCOPE_RE,
} from './smart-scopes'

// ─── Launch Code ────────────────────────────────────────────────────────────
export { signLaunchCode, verifyLaunchCode, toLaunchCodeOptions, type LaunchCodeServiceOptions, type LaunchCodeConfig } from './launch-code'

// ─── Redirect URI Validation ──────────────────────────────────────────────────
export { isRedirectUriRegistered, resolvePostLogoutUri, resolveClientHomeUrl, isProxyRoot, DEFAULT_CALLBACK_PATH, type GetRegisteredRedirectUris } from './redirect-uri'

export {
  isCimdClientId,
  resolveCimdRedirectUris,
  validateCimdDocument,
  clearCimdCache,
  type CimdDocument,
  type CimdOptions,
} from './cimd'

// ─── Stores ─────────────────────────────────────────────────────────────────
export type { ILaunchContextStore, LaunchContextStoreOptions } from './stores/interface'
export { MemoryStore } from './stores/memory'

// ─── Authorize Interceptor ──────────────────────────────────────────────────
export {
  handleAuthorize,
  type AuthorizeInterceptorDeps,
  type AuthorizeInterceptResult,
} from './authorize-interceptor'

// ─── Callback Handler ───────────────────────────────────────────────────────
export {
  handleCallback,
  handlePatientSelect,
  handleIdentitySelect,
  isPractitioner,
  ACCOUNT_NOT_LINKED_MESSAGE,
  PRACTITIONER_REQUIRED_MESSAGE,
  DEFAULT_IDENTITY_PICKER_PATH,
  type CallbackParams,
  type CallbackHandlerDeps,
  type CallbackResult,
} from './callback-handler'

// ─── Identity Choice ────────────────────────────────────────────────────────
export {
  chooseIdentity,
  candidatesForScopes,
  isOfferedIdentity,
  IDENTITY_TYPES,
  type IdentityCandidate,
  type IdentityChoice,
  type IdentityType,
} from './identity-choice'

// ─── Token Enricher ─────────────────────────────────────────────────────────
export {
  enrichTokenResponse,
  getRewrittenRedirectUri,
  getSessionAudience,
  type TokenEnricherDeps,
  type TokenEnrichInput,
} from './token-enricher'
export { hashAuthCode } from './auth-code'

// ─── Introspection Enricher ─────────────────────────────────────────────────
export { enrichIntrospection, type IntrospectionData } from './introspection-enricher'

// ─── FHIR User Utilities ────────────────────────────────────────────────────
export {
  extractPatientFromFhirUser,
  getFhirUserResourceType,
  isAbsoluteUrl,
  toAbsoluteFhirUser,
} from './fhir-user'

// ─── IdP Adapters ───────────────────────────────────────────────────────────
export type { IdPAdapter } from './idp/interface'
export { KeycloakAdapter, type KeycloakAdapterConfig } from './idp/keycloak'
