// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from './logger'
import { actorChain, sanitizeActor, type TokenActor } from './token-actor'

/**
 * Token Context Store
 *
 * Maps token JTI → SMART launch context that was issued with the token.
 * This is the production-correct way to ensure introspection returns the same
 * launch context that was in the original token response (SMART STU 2.2 §5.2).
 *
 * The session-based approach (LaunchContextStore) stores context BEFORE token issuance
 * and is consumed at token exchange time. This store captures the FINAL enriched context
 * AFTER token exchange and makes it available for introspection for the token's lifetime.
 *
 * Why not rely on Keycloak user attributes?
 * - User attributes are per-user, not per-session → concurrent sessions race
 * - Protocol mappers are unreliable in KC 26+ introspection responses
 * - The SMART spec says "patient" is a per-token launch context, not an identity claim
 *
 * Security considerations (OWASP OAuth2 / RFC 7662):
 * - Input validation: JTI length capped to prevent memory abuse
 * - Context values sanitized (max length, safe characters only)
 * - Returned objects are frozen copies (prevent store mutation via reference)
 * - Client binding: introspection verifies client_id matches stored context
 * - TTL capped: no entry survives longer than MAX_TTL_MS regardless of exp
 * - PHI redaction: patient IDs never logged in full
 *
 * Single-node in-memory implementation. For HA, swap with Redis-backed store.
 */

// ─── Security Constants ─────────────────────────────────────────────────────

/** Maximum allowed JTI length (UUIDs are 36 chars, KC uses ~36-40) */
const MAX_JTI_LENGTH = 128

/** Maximum allowed string value length for context fields */
const MAX_VALUE_LENGTH = 512

/** Maximum TTL regardless of token exp (24 hours — no token should live longer) */
const MAX_TTL_MS = 24 * 60 * 60 * 1000

/** Default TTL when exp is not provided (1 hour) */
const DEFAULT_TTL_MS = 3600_000

/** Pattern for valid FHIR resource IDs (alphanumeric, hyphens, dots, up to 64 chars) */
const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/

/** Pattern for valid FHIR references (ResourceType/id or absolute URL) */
const FHIR_REFERENCE_PATTERN = /^(https?:\/\/[^\s]{1,400}|[A-Za-z]{1,64}\/[A-Za-z0-9\-.]{1,64})$/

// ─── Types ──────────────────────────────────────────────────────────────────

/** Launch context associated with an issued token */
export interface TokenContext {
  /** Patient ID (FHIR resource ID, not full reference) */
  patient?: string
  /** Encounter ID */
  encounter?: string
  /** Absolute or relative fhirUser reference */
  fhirUser?: string
  /** Intent string */
  intent?: string
  /** SMART style URL */
  smart_style_url?: string
  /** Tenant identifier */
  tenant?: string
  /** Whether patient banner is needed */
  need_patient_banner?: boolean
  /** Client ID the token was issued to (used for client binding validation) */
  clientId?: string
  /** Token expiration timestamp (epoch seconds) */
  exp?: number
  /** RFC 8693 actor chain, set when the token came from a token exchange */
  act?: TokenActor
}

export interface TokenContextStoreOptions {
  /** Max entries before forced eviction of oldest (default: 50,000) */
  maxEntries?: number
  /** Cleanup interval in ms (default: 5 minutes) */
  cleanupIntervalMs?: number
}

export interface ITokenContextStore {
  /** Store context for a token identified by its JTI. TTL derived from exp. */
  set(jti: string, context: TokenContext): void
  /** Retrieve context by JTI. Returns null if not found or expired. */
  get(jti: string, clientId?: string): TokenContext | null
  /** Number of stored entries (monitoring). */
  size(): number
  /** Shutdown (cleanup timers). */
  dispose(): void
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

/** Validate and sanitize a JTI value */
function isValidJti(jti: string): boolean {
  return typeof jti === 'string' && jti.length > 0 && jti.length <= MAX_JTI_LENGTH
}

/** Sanitize a string field: trim and cap length */
function sanitizeStringField(value: string | undefined, maxLen = MAX_VALUE_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.slice(0, maxLen)
}

/** Validate a FHIR resource ID (patient, encounter) */
function isValidFhirId(id: string | undefined): boolean {
  if (!id) return true // undefined is valid (optional field)
  return FHIR_ID_PATTERN.test(id)
}

/** Validate a FHIR reference (fhirUser) */
function isValidFhirReference(ref: string | undefined): boolean {
  if (!ref) return true
  return FHIR_REFERENCE_PATTERN.test(ref)
}

/** Sanitize a full TokenContext, returning null if critically invalid */
function sanitizeContext(context: TokenContext): TokenContext | null {
  const patient = sanitizeStringField(context.patient, 64)
  const encounter = sanitizeStringField(context.encounter, 64)
  const fhirUser = sanitizeStringField(context.fhirUser, 400)
  const intent = sanitizeStringField(context.intent, 128)
  const smart_style_url = sanitizeStringField(context.smart_style_url, MAX_VALUE_LENGTH)
  const tenant = sanitizeStringField(context.tenant, 128)
  const clientId = sanitizeStringField(context.clientId, 256)
  const act = sanitizeActor(context.act)

  // Validate FHIR IDs don't contain injection characters
  if (!isValidFhirId(patient) || !isValidFhirId(encounter)) {
    logger.auth.warn('Token context rejected: invalid FHIR ID format')
    return null
  }

  if (!isValidFhirReference(fhirUser)) {
    logger.auth.warn('Token context rejected: invalid fhirUser reference format')
    return null
  }

  return {
    ...(patient && { patient }),
    ...(encounter && { encounter }),
    ...(fhirUser && { fhirUser }),
    ...(intent && { intent }),
    ...(smart_style_url && { smart_style_url }),
    ...(tenant && { tenant }),
    ...(context.need_patient_banner !== undefined && { need_patient_banner: !!context.need_patient_banner }),
    ...(clientId && { clientId }),
    ...(context.exp && { exp: context.exp }),
    ...(act && { act }),
  }
}

// ─── Store Implementation ───────────────────────────────────────────────────

/**
 * In-memory token context store with expiration-based TTL.
 * Entries expire when the token's `exp` timestamp passes (capped at MAX_TTL_MS).
 */
export class TokenContextStore implements ITokenContextStore {
  private store = new Map<string, { context: Readonly<TokenContext>; expiresAt: number }>()
  private maxEntries: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: TokenContextStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 50_000
    const cleanupInterval = options.cleanupIntervalMs ?? 5 * 60 * 1000

    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval)
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  set(jti: string, context: TokenContext): void {
    // Input validation: reject invalid JTI
    if (!isValidJti(jti)) {
      logger.auth.warn('Token context store: rejected invalid JTI', { length: jti?.length })
      return
    }

    // Sanitize and validate context values
    const sanitized = sanitizeContext(context)
    if (!sanitized) return

    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value
      if (firstKey) this.store.delete(firstKey)
    }

    // Calculate TTL: use token's exp but cap at MAX_TTL_MS
    const now = Date.now()
    let expiresAt: number
    if (sanitized.exp) {
      const tokenExpMs = sanitized.exp * 1000
      // Reject tokens claiming to expire in the past
      if (tokenExpMs <= now) return
      // Cap at MAX_TTL_MS from now
      expiresAt = Math.min(tokenExpMs, now + MAX_TTL_MS)
    } else {
      expiresAt = now + DEFAULT_TTL_MS
    }

    // Freeze the context to prevent mutation via reference
    for (let a = sanitized.act; a; a = a.act) Object.freeze(a)
    const frozen = Object.freeze(sanitized)
    this.store.set(jti, { context: frozen, expiresAt })

    logger.auth.debug('Token context stored', {
      jti: jti.slice(0, 8) + '...',
      hasPatient: !!sanitized.patient,
      clientId: sanitized.clientId,
    })
  }

  get(jti: string, clientId?: string): TokenContext | null {
    // Input validation
    if (!isValidJti(jti)) return null

    const entry = this.store.get(jti)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(jti)
      return null
    }

    // Client binding check: if clientId provided, verify it matches
    // This prevents one client from reading another client's token context
    if (clientId && entry.context.clientId && entry.context.clientId !== clientId) {
      logger.auth.warn('Token context access denied: client binding mismatch', {
        jti: jti.slice(0, 8) + '...',
        requestingClient: clientId.slice(0, 16),
      })
      return null
    }

    // Return a defensive copy (frozen original + spread = new object)
    return { ...entry.context }
  }

  size(): number {
    return this.store.size
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.store.clear()
  }

  private cleanup(): void {
    const now = Date.now()
    let cleaned = 0
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
        cleaned++
      }
    }
    if (cleaned > 0) {
      logger.auth.debug('Token context cleanup', { removed: cleaned, remaining: this.store.size })
    }
  }
}

/** Singleton instance */
export const tokenContextStore = new TokenContextStore()

/** The stored actor chain of a validated token, bound to its azp; [] when it was not exchanged. */
export function tokenActorChain(payload: Record<string, unknown>): string[] {
  const jti = payload.jti
  if (typeof jti !== 'string') return []
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined
  return actorChain(tokenContextStore.get(jti, azp)?.act)
}
