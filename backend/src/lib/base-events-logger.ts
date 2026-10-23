// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Base Events Logger
 *
 * The Keycloak-polling half of an events logger: incremental event fetch via
 * client_credentials on top of the shared EventJournal, which owns persistence,
 * the ring buffer, pub/sub and the analytics cycle.
 *
 * Subclasses provide the event types to poll, the Keycloak → domain mapping and
 * their own analytics.
 */

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { config } from '../config'
import { EventJournal, type JournalLogChannel } from './events/journal'
import { bucketByHour, countBy, percent } from './events/aggregate'
import { TokenCache, fetchedTokenFrom, type FetchedToken } from './cache/token-cache'

export { DEFAULT_RING_BUFFER_SIZE as RING_BUFFER_SIZE } from './events/journal'

/** Keycloak EventRepresentation shape */
const KeycloakEventSchema = Type.Object({
  id: Type.Optional(Type.String()),
  time: Type.Optional(Type.Number()),
  type: Type.Optional(Type.String()),
  realmId: Type.Optional(Type.String()),
  clientId: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  ipAddress: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.String())),
})
export type KeycloakEvent = Static<typeof KeycloakEventSchema>

function keycloakEvents(body: unknown): KeycloakEvent[] {
  if (!Array.isArray(body)) return []
  return body.filter((event): event is KeycloakEvent => Value.Check(KeycloakEventSchema, event))
}

/** Minimum shape every domain event must have */
export interface BaseEvent {
  id: string
  timestamp: string
  type: string
  success: boolean
}

/** Minimum shape every analytics object must have */
export interface BaseAnalytics {
  totalEvents: number
  successRate: number
  eventsByType: Record<string, number>
  hourlyStats: Array<{ hour: string; success: number; failure: number; total: number }>
  timestamp: string
}

/** Fields every logger maps the same way out of a Keycloak event. */
export interface MappedKeycloakEvent extends BaseEvent {
  userId?: string
  clientId?: string
  ipAddress?: string
  error?: string
  details?: Record<string, string>
}

/**
 * Map the fields every domain event shares out of a Keycloak event.
 *
 * A Keycloak event is a failure if its type ends in _ERROR or it carries an
 * error string; both checks matter, since some types report failure only in the
 * error field. Subclasses spread this and add their own fields.
 */
export function mapBaseKeycloakEvent(kc: KeycloakEvent, idPrefix: string): MappedKeycloakEvent {
  const isError = kc.type?.endsWith('_ERROR') ?? false
  return {
    id: kc.id ?? `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: kc.time ? new Date(kc.time).toISOString() : new Date().toISOString(),
    type: kc.type ?? 'UNKNOWN',
    userId: kc.userId,
    clientId: kc.clientId,
    ipAddress: kc.ipAddress,
    error: kc.error,
    success: !isError && !kc.error,
    details: kc.details,
  }
}

export interface EventLoggerConfig<TEvent extends BaseEvent> {
  /** Subdirectory name under logs/ (e.g. 'auth-events', 'email-events') */
  logSubdir: string
  /** JSONL filename (e.g. 'auth-events.jsonl') */
  logFilename: string
  /** Keycloak event types to poll */
  eventTypes: readonly string[]
  /** Log channel for this logger's own messages */
  channel: JournalLogChannel
  /** Map a Keycloak event to a domain event */
  mapEvent: (kc: KeycloakEvent) => TEvent
  /** ID prefix for generated IDs (e.g. 'auth', 'email') */
  idPrefix: string
  /** Absolute log directory override; tests point it at a temp dir. */
  logDir?: string
}

const DEFAULT_POLL_INTERVAL_MS = 60_000
const TOKEN_KEY = 'events-poller'

/** Shared across pollers, so two loggers starting together fetch one token. */
const adminTokens = new TokenCache()

async function fetchPollerToken(): Promise<FetchedToken> {
  const tokenUrl = `${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.keycloak.adminClientId ?? '',
      client_secret: config.keycloak.adminClientSecret ?? '',
    }),
  })

  if (!res.ok) {
    throw new Error(`Admin token request failed: ${res.status}`)
  }

  return fetchedTokenFrom(await res.json())
}

export abstract class BaseEventsLogger<
  TEvent extends BaseEvent,
  TAnalytics extends BaseAnalytics,
> extends EventJournal<TEvent, TAnalytics> {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPollTimestamp = 0

  constructor(protected readonly cfg: EventLoggerConfig<TEvent>) {
    super({
      logSubdir: cfg.logSubdir,
      logFilename: cfg.logFilename,
      idPrefix: cfg.idPrefix,
      channel: cfg.channel,
      logDir: cfg.logDir,
    })
  }

  start(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return
    void this.pollKeycloakEvents()
    this.timer = setInterval(() => void this.pollKeycloakEvents(), intervalMs)
    this.channel.info(`${this.cfg.idPrefix} events poller started`, { intervalMs })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getRecentEvents(opts?: {
    limit?: number
    type?: string
    success?: boolean
    since?: Date
  }): TEvent[] {
    return this.selectEvents(
      opts,
      event => !opts?.type || opts.type === 'all' || event.type === opts.type,
      event => opts?.success === undefined || event.success === opts.success,
    )
  }

  /** Base analytics fields shared by all event loggers. */
  protected computeBaseAnalytics(recent: TEvent[]): BaseAnalytics {
    return {
      totalEvents: recent.length,
      successRate: percent(recent.filter(event => event.success).length, recent.length, {
        round: true,
        fallback: 100,
      }),
      eventsByType: countBy(recent, event => event.type),
      hourlyStats: bucketByHour(
        recent,
        () => ({ success: 0, failure: 0 }),
        (bucket, event) => {
          if (event.success) bucket.success++
          else bucket.failure++
        },
      ).map(({ hour, success, failure }) => ({ hour, success, failure, total: success + failure })),
      timestamp: new Date().toISOString(),
    }
  }

  /** The newest loaded event sets the poll cursor, so a restart does not refetch. */
  protected afterLoad(): void {
    const newest = this.events[0]
    if (!newest) return
    const at = Date.parse(newest.timestamp)
    if (at > this.lastPollTimestamp) this.lastPollTimestamp = at
  }

  private async pollKeycloakEvents(): Promise<void> {
    if (!config.keycloak.isConfigured || !config.keycloak.adminClientId || !config.keycloak.adminClientSecret) {
      return
    }

    try {
      const token = await this.getAdminToken()
      if (!token) return

      const params = new URLSearchParams()
      for (const type of this.cfg.eventTypes) {
        params.append('type', type)
      }
      if (this.lastPollTimestamp > 0) {
        params.set('dateFrom', String(this.lastPollTimestamp + 1))
      }
      params.set('max', '500')
      params.set('direction', 'desc')

      const url = `${config.keycloak.baseUrl}/admin/realms/${config.keycloak.realm}/events?${params.toString()}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

      if (!res.ok) {
        this.channel.warn(`Failed to fetch Keycloak ${this.cfg.idPrefix} events`, { status: res.status })
        return
      }

      const kcEvents = keycloakEvents(await res.json())
      if (kcEvents.length === 0) return

      for (const kc of [...kcEvents].reverse()) {
        await this.append(this.cfg.mapEvent(kc), { dedupe: true })
      }

      const newest = Math.max(...kcEvents.map(event => event.time ?? 0))
      if (newest > this.lastPollTimestamp) {
        this.lastPollTimestamp = newest
      }

      await this.refreshAnalytics()
      this.channel.debug(`Polled ${this.cfg.idPrefix} events from Keycloak`, { count: kcEvents.length })
    } catch (error) {
      this.channel.error(`Error polling Keycloak ${this.cfg.idPrefix} events`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Null on any failure: a poll is skipped, and the next one retries. */
  private async getAdminToken(): Promise<string | null> {
    try {
      return await adminTokens.get(TOKEN_KEY, fetchPollerToken)
    } catch (error) {
      this.channel.error(`Failed to obtain admin token for ${this.cfg.idPrefix} events polling`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}
