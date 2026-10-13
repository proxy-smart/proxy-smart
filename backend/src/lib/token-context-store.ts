// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Value } from '@sinclair/typebox/value'
import { logger } from './logger'
import { actorChain, sanitizeActor, type TokenActor } from './token-actor'
import { isRecord } from './type-guards'
import { hasDatabaseUrl } from './pg-pool'
import { TtlCache } from './cache/ttl-cache'
import { OutageNotice } from './cache/pg-expiring-table'
import { PostgresTokenContextBackend } from './cache/pg-token-context'
import { FhirContextItem, type FhirContextItemType } from '../schemas/auth/oauth'
import { FHIR_ID_PATTERN } from './fhir-reference'

/**
 * Token Context Store
 *
 * Maps a token's jti to the SMART launch context issued with it, so introspection repeats the
 * token response's context (SMART 2.2 §5.2) and the FHIR proxy can find the token's patient.
 * Context is sanitised on the way in and again when read back from the shared backend, reads are
 * bound to the client the token was issued to, and no entry outlives MAX_TTL_MS.
 *
 * With a database configured, contexts are also written to Postgres, so any node can answer for a
 * token another node issued. Each node keeps what it wrote or read in memory.
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

/** How long a node keeps a context it read from the shared backend before reading it again. */
const SHARED_CACHE_MS = 60_000

/** How long a node remembers that no context exists for a jti. */
const MISS_CACHE_MS = 15_000

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
  /** SMART fhirContext entries from the token response */
  fhirContext?: FhirContextItemType[]
}

/** A row as the shared backend returns it; `context` is untrusted until sanitised. */
export interface StoredTokenContext {
  context: unknown
  /** Epoch milliseconds */
  expiresAt: number
}

/** The store every node shares. Rows past `expiresAt` must not be returned. */
export interface SharedTokenContextBackend {
  put(jti: string, context: TokenContext, expiresAt: number): Promise<void>
  fetch(jti: string, now: number): Promise<StoredTokenContext | null>
  remove(jti: string): Promise<void>
  dispose(): void
}

export interface TokenContextStoreOptions {
  /** Max entries this node keeps in memory (default: 50,000) */
  maxEntries?: number
  /** Cleanup interval in ms (default: 5 minutes) */
  cleanupIntervalMs?: number
  /** Shared backend; null keeps the store on this node only */
  shared?: SharedTokenContextBackend | null
  sharedCacheMs?: number
  missCacheMs?: number
}

/** A context this node holds, or null for a remembered miss. */
type CachedContext = { context: Readonly<TokenContext>; expiresAt: number } | null

// ─── Validation Helpers ─────────────────────────────────────────────────────

function isValidJti(jti: string): boolean {
  return typeof jti === 'string' && jti.length > 0 && jti.length <= MAX_JTI_LENGTH
}

/** Sanitize a string field: trim and cap length */
function sanitizeStringField(value: unknown, maxLen = MAX_VALUE_LENGTH): string | undefined {
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

const MAX_FHIR_CONTEXT_ITEMS = 32
const MAX_FHIR_CONTEXT_BYTES = 8192

/** A well-formed, bounded fhirContext, or undefined. */
export function sanitizeFhirContext(value: unknown): FhirContextItemType[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FHIR_CONTEXT_ITEMS) return undefined
  if (!value.every((item) => Value.Check(FhirContextItem, item))) return undefined
  const json = JSON.stringify(value)
  return json.length <= MAX_FHIR_CONTEXT_BYTES ? JSON.parse(json) : undefined
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

/** Sanitize a context from either source, returning null if critically invalid */
function sanitizeContext(context: Record<string, unknown>): TokenContext | null {
  const patient = sanitizeStringField(context.patient, 64)
  const encounter = sanitizeStringField(context.encounter, 64)
  const fhirUser = sanitizeStringField(context.fhirUser, 400)
  const intent = sanitizeStringField(context.intent, 128)
  const smart_style_url = sanitizeStringField(context.smart_style_url, MAX_VALUE_LENGTH)
  const tenant = sanitizeStringField(context.tenant, 128)
  const clientId = sanitizeStringField(context.clientId, 256)
  const act = sanitizeActor(context.act)
  const fhirContext = sanitizeFhirContext(context.fhirContext)
  const exp = typeof context.exp === 'number' && Number.isFinite(context.exp) ? context.exp : undefined
  const needPatientBanner = context.need_patient_banner

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
    ...(needPatientBanner !== undefined && needPatientBanner !== null && { need_patient_banner: !!needPatientBanner }),
    ...(clientId && { clientId }),
    ...(exp && { exp }),
    ...(act && { act }),
    ...(fhirContext && { fhirContext }),
  }
}

/** When the entry expires (epoch ms), or null when the token already has. */
function expiryOf(context: TokenContext, now: number): number | null {
  if (!context.exp) return now + DEFAULT_TTL_MS
  const tokenExpMs = context.exp * 1000
  if (tokenExpMs <= now) return null
  return Math.min(tokenExpMs, now + MAX_TTL_MS)
}

// ─── Store Implementation ───────────────────────────────────────────────────

export class TokenContextStore {
  private readonly cache: TtlCache<CachedContext>
  private readonly shared: SharedTokenContextBackend | null
  private readonly sharedCacheMs: number
  private readonly missCacheMs: number
  private readonly outage = new OutageNotice('token context store')

  constructor(options: TokenContextStoreOptions = {}) {
    this.cache = new TtlCache<CachedContext>({
      ttlMs: DEFAULT_TTL_MS,
      maxEntries: options.maxEntries ?? 50_000,
      cleanupIntervalMs: options.cleanupIntervalMs ?? 5 * 60 * 1000,
    })
    this.shared = options.shared ?? null
    this.sharedCacheMs = options.sharedCacheMs ?? SHARED_CACHE_MS
    this.missCacheMs = options.missCacheMs ?? MISS_CACHE_MS
  }

  /** Store context for a token identified by its JTI. TTL derived from exp. */
  async set(jti: string, context: TokenContext): Promise<void> {
    if (!isValidJti(jti)) {
      logger.auth.warn('Token context store: rejected invalid JTI', { length: jti?.length })
      return
    }

    const sanitized = sanitizeContext({ ...context })
    if (!sanitized) return

    const now = Date.now()
    const expiresAt = expiryOf(sanitized, now)
    if (expiresAt === null) return

    deepFreeze(sanitized)
    this.cache.set(jti, { context: sanitized, expiresAt }, expiresAt - now)

    logger.auth.debug('Token context stored', {
      jti: jti.slice(0, 8) + '...',
      hasPatient: !!sanitized.patient,
      clientId: sanitized.clientId,
    })

    if (!this.shared) return
    try {
      await this.shared.put(jti, sanitized, expiresAt)
      this.outage.recovered()
    } catch (error) {
      this.outage.failed('write', error)
    }
  }

  /** Context by JTI, or null when unknown, expired, or bound to another client. */
  async get(jti: string, clientId?: string): Promise<TokenContext | null> {
    if (!isValidJti(jti)) return null

    const entry = this.shared
      ? await this.cache.getOrLoad(jti, () => this.load(jti), (loaded) => this.localTtl(loaded))
      : this.cache.get(jti)
    if (!entry) return null

    // Client binding: one client must not read the context of another client's token
    if (clientId && entry.context.clientId && entry.context.clientId !== clientId) {
      logger.auth.warn('Token context access denied: client binding mismatch', {
        jti: jti.slice(0, 8) + '...',
        requestingClient: clientId.slice(0, 16),
      })
      return null
    }

    return { ...entry.context }
  }

  /** Drop a revoked token's context, under the same client binding as get. True when one was removed. */
  async delete(jti: string, clientId?: string): Promise<boolean> {
    if (!(await this.get(jti, clientId))) return false
    this.cache.delete(jti)
    if (!this.shared) return true
    try {
      await this.shared.remove(jti)
      this.outage.recovered()
    } catch (error) {
      this.outage.failed('delete', error)
    }
    return true
  }

  /** Entries held on this node (monitoring). */
  size(): number {
    return this.cache.size
  }

  dispose(): void {
    this.cache.dispose()
    this.shared?.dispose()
  }

  private async load(jti: string): Promise<CachedContext> {
    if (!this.shared) return null
    try {
      const row = await this.shared.fetch(jti, Date.now())
      this.outage.recovered()
      if (!row) return null
      const context = isRecord(row.context) ? sanitizeContext(row.context) : null
      if (!context) {
        logger.auth.warn('Token context store: discarded an invalid shared row', { jti: jti.slice(0, 8) + '...' })
        return null
      }
      deepFreeze(context)
      return { context, expiresAt: row.expiresAt }
    } catch (error) {
      this.outage.failed('read', error)
      return null
    }
  }

  private localTtl(loaded: CachedContext): number {
    if (!loaded) return this.missCacheMs
    return Math.max(1, Math.min(loaded.expiresAt - Date.now(), this.sharedCacheMs))
  }
}

/** Singleton instance */
export const tokenContextStore = new TokenContextStore({
  shared: hasDatabaseUrl() ? new PostgresTokenContextBackend() : null,
})

/** The stored actor chain of a validated token, bound to its azp; [] when it was not exchanged. */
export async function tokenActorChain(payload: Record<string, unknown>): Promise<string[]> {
  const jti = payload.jti
  if (typeof jti !== 'string') return []
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined
  return actorChain((await tokenContextStore.get(jti, azp))?.act)
}
