// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Event journal — the substrate under every events logger: JSONL persistence,
 * ring buffer, pub/sub, bootstrap from disk, analytics refresh.
 *
 * Subclasses own only their event shape, their filters and their aggregation.
 */

import { appendFile, mkdir, writeFile } from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'

/** Minimum shape the journal needs to persist, order and window an event. */
export interface JournalEvent {
  id: string
  timestamp: string
}

/** The log channels of ./logger, structurally. */
export interface JournalLogChannel {
  error(message: string, data?: Record<string, unknown>, error?: Error): void
  warn(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
}

export interface EventJournalConfig {
  /** Subdirectory under logs/, e.g. 'oauth-metrics'. */
  logSubdir: string
  /** JSONL filename, e.g. 'oauth-events.jsonl'. */
  logFilename: string
  /** Prefix for generated event ids and log lines, e.g. 'oauth'. */
  idPrefix: string
  channel: JournalLogChannel
  ringBufferSize?: number
  /** Age limit when loading from disk; omit to take the newest ring buffer's worth. */
  loadWindowMs?: number
  /** Window analytics are computed over. Defaults to 24h. */
  analyticsWindowMs?: number
  /** Snapshot analytics to this file in the log dir on every pass. */
  analyticsFilename?: string
  /** Absolute log directory, overriding logs/<logSubdir>. Tests point it at a temp dir. */
  logDir?: string
}

/** What the monitoring and websocket route factories need from a journal. */
export interface MonitoringLogger<TEvent, TAnalytics> {
  subscribe(cb: (event: TEvent) => void): () => void
  subscribeAnalytics(cb: (analytics: TAnalytics) => void): () => void
  getRecentEvents(opts?: { limit?: number }): TEvent[]
  getAnalytics(): TAnalytics | null
}

export const DEFAULT_RING_BUFFER_SIZE = 1000
const DEFAULT_ANALYTICS_WINDOW_MS = 24 * 60 * 60 * 1000

export abstract class EventJournal<TEvent extends JournalEvent, TAnalytics> {
  protected readonly logDir: string
  protected readonly eventsFile: string
  protected readonly ringBufferSize: number
  protected readonly analyticsWindowMs: number
  protected readonly channel: JournalLogChannel
  protected events: TEvent[] = []
  protected analytics: TAnalytics | null = null

  private readonly analyticsFile: string | null
  private readonly subscribers = new Set<(event: TEvent) => void>()
  private readonly analyticsSubscribers = new Set<(analytics: TAnalytics) => void>()
  private initialized = false

  constructor(protected readonly journalConfig: EventJournalConfig) {
    this.logDir = journalConfig.logDir ?? join(process.cwd(), 'logs', journalConfig.logSubdir)
    this.eventsFile = join(this.logDir, journalConfig.logFilename)
    this.analyticsFile = journalConfig.analyticsFilename
      ? join(this.logDir, journalConfig.analyticsFilename)
      : null
    this.ringBufferSize = journalConfig.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE
    this.analyticsWindowMs = journalConfig.analyticsWindowMs ?? DEFAULT_ANALYTICS_WINDOW_MS
    this.channel = journalConfig.channel
  }

  /** Domain aggregation over the analytics window. */
  protected abstract computeAnalytics(recent: TEvent[]): TAnalytics

  async initialize(): Promise<void> {
    if (this.initialized) return

    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true })
    }

    await this.loadPersistedEvents()
    await this.refreshAnalytics()
    this.initialized = true
    this.channel.info(`${this.journalConfig.idPrefix} events logger initialized`, {
      eventsLoaded: this.events.length,
    })
  }

  // ─── Write path ──────────────────────────────────────────────

  /** Id and timestamp for a new event, so subclasses keep their own event type. */
  protected stamp(): { id: string; timestamp: string } {
    return {
      id: `${this.journalConfig.idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      timestamp: new Date().toISOString(),
    }
  }

  /** Append, notify, then refresh analytics: the single-event write path. */
  protected async record(event: TEvent): Promise<void> {
    await this.append(event)
    await this.refreshAnalytics()
  }

  /**
   * Append to the ring buffer and the JSONL file, then notify event
   * subscribers. Analytics are left alone, so a batch writer refreshes once.
   */
  protected async append(event: TEvent, opts?: { dedupe?: boolean }): Promise<void> {
    if (opts?.dedupe && this.events.some(existing => existing.id === event.id)) return

    this.events.unshift(event)
    if (this.events.length > this.ringBufferSize) {
      this.events.length = this.ringBufferSize
    }

    try {
      await appendFile(this.eventsFile, JSON.stringify(event) + '\n', 'utf8')
    } catch (error) {
      this.channel.error(`Failed to persist ${this.journalConfig.idPrefix} event`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    for (const cb of this.subscribers) {
      try { cb(event) } catch { /* a subscriber must not break the writer */ }
    }
  }

  // ─── Read path ───────────────────────────────────────────────

  /** Events in the analytics window, newest first. */
  protected eventsInWindow(): TEvent[] {
    const cutoff = Date.now() - this.analyticsWindowMs
    return this.events.filter(event => Date.parse(event.timestamp) >= cutoff)
  }

  /** Newest-first copy narrowed by the common options and any domain predicates. */
  protected selectEvents(
    opts?: { limit?: number; since?: Date },
    ...predicates: Array<(event: TEvent) => boolean>
  ): TEvent[] {
    let result = [...this.events]

    for (const predicate of predicates) {
      result = result.filter(predicate)
    }
    if (opts?.since) {
      const since = opts.since.getTime()
      result = result.filter(event => Date.parse(event.timestamp) >= since)
    }
    if (opts?.limit) {
      result = result.slice(0, opts.limit)
    }
    return result
  }

  getRecentEvents(opts?: { limit?: number; since?: Date }): TEvent[] {
    return this.selectEvents(opts)
  }

  getAnalytics(): TAnalytics | null {
    return this.analytics
  }

  getEventCount(): number {
    return this.events.length
  }

  getEventCapacity(): number {
    return this.ringBufferSize
  }

  getThroughputPerMinute(): number {
    const cutoff = Date.now() - 60_000
    return this.events.filter(event => Date.parse(event.timestamp) >= cutoff).length
  }

  // ─── Pub/sub ─────────────────────────────────────────────────

  subscribe(cb: (event: TEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  subscribeAnalytics(cb: (analytics: TAnalytics) => void): () => void {
    this.analyticsSubscribers.add(cb)
    return () => { this.analyticsSubscribers.delete(cb) }
  }

  // ─── Analytics ───────────────────────────────────────────────

  protected async refreshAnalytics(): Promise<void> {
    try {
      const analytics = this.computeAnalytics(this.eventsInWindow())
      this.analytics = analytics

      if (this.analyticsFile) {
        await writeFile(this.analyticsFile, JSON.stringify(analytics, null, 2))
      }
      for (const cb of this.analyticsSubscribers) {
        try { cb(analytics) } catch { /* a subscriber must not break the writer */ }
      }
    } catch (error) {
      this.channel.error(`Failed to recalculate ${this.journalConfig.idPrefix} analytics`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ─── Bootstrap ───────────────────────────────────────────────

  /** Runs after the ring buffer is populated from disk. */
  protected afterLoad(): void { /* overridden where the load feeds further state */ }

  private async loadPersistedEvents(): Promise<void> {
    if (!existsSync(this.eventsFile)) return

    const cutoff = this.journalConfig.loadWindowMs
      ? Date.now() - this.journalConfig.loadWindowMs
      : null
    const loaded: TEvent[] = []

    try {
      const stream = createReadStream(this.eventsFile, { encoding: 'utf-8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })

      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed: TEvent = JSON.parse(trimmed)
          const at = Date.parse(parsed.timestamp)
          if (!Number.isFinite(at)) continue
          if (cutoff !== null && at < cutoff) continue
          loaded.push(parsed)
        } catch { /* a corrupt line must not stop the load */ }
      }
    } catch (error) {
      this.channel.error(`Failed to load persisted ${this.journalConfig.idPrefix} events`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    this.events = loaded
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, this.ringBufferSize)
    this.afterLoad()
  }
}
