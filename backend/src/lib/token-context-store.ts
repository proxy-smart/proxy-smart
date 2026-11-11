// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Value } from '@sinclair/typebox/value'
import { logger } from './logger'
import { actorChain, sanitizeActor, type TokenActor } from './token-actor'
import { isRecord, optionalString } from './type-guards'
import { hasDatabaseUrl } from './pg-pool'
import { TtlCache } from './cache/ttl-cache'
import { OutageNotice } from './cache/pg-expiring-table'
import { PostgresTokenContextBackend } from './cache/pg-token-context'
import { FhirContextItem, type FhirContextItemType } from '../schemas/auth/oauth'
import { FHIR_ID_PATTERN } from './fhir-reference'

// jti -> SMART launch context, so introspection repeats it (SMART 2.2 §5.2). Sanitised on write and
// on read from the shared Postgres backend, and bound to the client the token was issued to.

const MAX_JTI_LENGTH = 128

const MAX_VALUE_LENGTH = 512

const MAX_TTL_MS = 24 * 60 * 60 * 1000

const DEFAULT_TTL_MS = 3600_000

/** Refresh tokens outlive access tokens; an offline token may carry no exp at all. */
const REFRESH_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

const REFRESH_KEY_PREFIX = 'refresh:'

const MAX_SCOPE_LENGTH = 4096

/** How long a node keeps a context it read from the shared backend before reading it again. */
const SHARED_CACHE_MS = 60_000

/** How long a node remembers that no context exists for a jti. */
const MISS_CACHE_MS = 15_000

const FHIR_REFERENCE_PATTERN = /^(https?:\/\/[^\s]{1,400}|[A-Za-z]{1,64}\/[A-Za-z0-9\-.]{1,64})$/

export interface TokenContext {
  /** FHIR resource id, not a reference */
  patient?: string
  encounter?: string
  fhirUser?: string
  intent?: string
  smart_style_url?: string
  tenant?: string
  need_patient_banner?: boolean
  clientId?: string
  /** Epoch seconds */
  exp?: number
  /** RFC 8693 actor chain, set when the token came from a token exchange */
  act?: TokenActor
  fhirContext?: FhirContextItemType[]
  scope?: string
}

interface TtlLimits {
  defaultMs: number
  maxMs: number
}

const ACCESS_TOKEN_TTL: TtlLimits = { defaultMs: DEFAULT_TTL_MS, maxMs: MAX_TTL_MS }
const REFRESH_TOKEN_TTL: TtlLimits = { defaultMs: REFRESH_MAX_TTL_MS, maxMs: REFRESH_MAX_TTL_MS }

const refreshKey = (refreshJti: string) => `${REFRESH_KEY_PREFIX}${refreshJti}`

/** A row as the shared backend returns it; `context` is untrusted until sanitised. */
export interface StoredTokenContext {
  context: unknown
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
  maxEntries?: number
  cleanupIntervalMs?: number
  shared?: SharedTokenContextBackend | null
  sharedCacheMs?: number
  missCacheMs?: number
}

/** A context this node holds, or null for a remembered miss. */
type CachedContext = { context: Readonly<TokenContext>; expiresAt: number } | null

function isValidJti(jti: string): boolean {
  return typeof jti === 'string' && jti.length > 0 && jti.length <= MAX_JTI_LENGTH
}

function sanitizeStringField(value: unknown, maxLen = MAX_VALUE_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.slice(0, maxLen)
}

function isValidFhirId(id: string | undefined): boolean {
  if (!id) return true
  return FHIR_ID_PATTERN.test(id)
}

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
  const scope = sanitizeStringField(context.scope, MAX_SCOPE_LENGTH)
  const exp = typeof context.exp === 'number' && Number.isFinite(context.exp) ? context.exp : undefined
  const needPatientBanner = context.need_patient_banner

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
    ...(scope && { scope }),
  }
}

/** When the entry expires (epoch ms), or null when the token already has. */
function expiryOf(context: TokenContext, now: number, limits: TtlLimits): number | null {
  if (!context.exp) return now + limits.defaultMs
  const tokenExpMs = context.exp * 1000
  if (tokenExpMs <= now) return null
  return Math.min(tokenExpMs, now + limits.maxMs)
}

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

  async set(jti: string, context: TokenContext): Promise<void> {
    await this.put(jti, context, ACCESS_TOKEN_TTL)
  }

  /** Context for a refresh token, so a refresh grant can hand the launch context on. */
  async setForRefreshToken(refreshJti: string, context: TokenContext): Promise<void> {
    if (!isValidJti(refreshJti)) return
    await this.put(refreshKey(refreshJti), context, REFRESH_TOKEN_TTL)
  }

  async getForRefreshToken(refreshJti: string, clientId?: string): Promise<TokenContext | null> {
    if (!isValidJti(refreshJti)) return null
    return this.get(refreshKey(refreshJti), clientId)
  }

  async deleteForRefreshToken(refreshJti: string, clientId?: string): Promise<boolean> {
    if (!isValidJti(refreshJti)) return false
    return this.delete(refreshKey(refreshJti), clientId)
  }

  private async put(jti: string, context: TokenContext, limits: TtlLimits): Promise<void> {
    if (!isValidJti(jti)) {
      logger.auth.warn('Token context store: rejected invalid JTI', { length: jti?.length })
      return
    }

    const sanitized = sanitizeContext({ ...context })
    if (!sanitized) return

    const now = Date.now()
    const expiresAt = expiryOf(sanitized, now, limits)
    if (expiresAt === null) return

    deepFreeze(sanitized)
    this.cache.set(jti, { context: sanitized, expiresAt }, expiresAt - now)

    logger.auth.debug('Token context stored', {
      jti: jti.slice(0, 8) + '...',
      hasPatient: !!sanitized.patient,
      clientId: sanitized.clientId,
    })

    const shared = this.shared
    if (shared) await this.outage.attempt('write', () => shared.put(jti, sanitized, expiresAt), undefined)
  }

  /** Context by JTI, or null when unknown, expired, or bound to another client. */
  async get(jti: string, clientId?: string): Promise<TokenContext | null> {
    if (!isValidJti(jti)) return null

    const entry = this.shared
      ? await this.cache.getOrLoad(jti, () => this.load(jti), (loaded) => this.localTtl(loaded))
      : this.cache.get(jti)
    if (!entry) return null

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
    const shared = this.shared
    if (shared) await this.outage.attempt('delete', () => shared.remove(jti), undefined)
    return true
  }

  size(): number {
    return this.cache.size
  }

  dispose(): void {
    this.cache.dispose()
    this.shared?.dispose()
  }

  private async load(jti: string): Promise<CachedContext> {
    const shared = this.shared
    if (!shared) return null
    const row = await this.outage.attempt('read', () => shared.fetch(jti, Date.now()), null)
    if (!row) return null
    const context = isRecord(row.context) ? sanitizeContext(row.context) : null
    if (!context) {
      logger.auth.warn('Token context store: discarded an invalid shared row', { jti: jti.slice(0, 8) + '...' })
      return null
    }
    deepFreeze(context)
    return { context, expiresAt: row.expiresAt }
  }

  private localTtl(loaded: CachedContext): number {
    if (!loaded) return this.missCacheMs
    return Math.max(1, Math.min(loaded.expiresAt - Date.now(), this.sharedCacheMs))
  }
}

export const tokenContextStore = new TokenContextStore({
  shared: hasDatabaseUrl() ? new PostgresTokenContextBackend() : null,
})

/** The stored actor chain of a validated token, bound to its azp; [] when it was not exchanged. */
export async function tokenActorChain(payload: Record<string, unknown>): Promise<string[]> {
  const jti = payload.jti
  if (typeof jti !== 'string') return []
  const azp = optionalString(payload.azp)
  return actorChain((await tokenContextStore.get(jti, azp))?.act)
}
