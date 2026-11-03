// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * FHIR Server Health Logger
 *
 * Probes every registered FHIR server's /metadata on an interval, uncached and over the same
 * upstream connection the proxy uses,
 * persists results to JSONL, and exposes an in-memory ring buffer + pub/sub
 * so the monitoring UI can query history and subscribe to real-time updates.
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'
import { config } from '../config'
import { normalizeFHIRVersion } from './fhir-utils'
import { isCapabilityStatement } from './fhir-capability-statement'
import { getAllServers, type FHIRServerInfo } from './fhir-server-store'
import { upstreamFetch, type UpstreamFetch } from './upstream-fetch'
import { matchesSchema } from './type-guards'
import {
  FhirHealthCheckSchema,
  type FhirHealthCheckSchemaType,
  type FhirUptimeSummarySchemaType,
} from '@/schemas/monitoring'

// ─── Types ───────────────────────────────────────────────────────

export type FhirHealthCheck = FhirHealthCheckSchemaType
export type FhirUptimeSummary = FhirUptimeSummarySchemaType

const isHealthCheck = matchesSchema(FhirHealthCheckSchema)

// ─── Logger class ────────────────────────────────────────────────

const MAX_MEMORY_CHECKS = 2880 // ~24h at 30s intervals per server
const DEFAULT_INTERVAL_MS = 30_000
const CHECK_TIMEOUT_MS = 10_000

export interface FhirHealthLoggerOptions {
  /** Defaults to logs/fhir-health. */
  logDir?: string
  /** The servers to check; defaults to every registered one. */
  servers?: () => Promise<FHIRServerInfo[]>
  fetch?: UpstreamFetch
}

export class FhirHealthLogger {
  private readonly logDir: string
  private readonly checksFile: string
  private checks: FhirHealthCheck[] = []
  private subscribers = new Set<(check: FhirHealthCheck) => void>()
  private summarySubscribers = new Set<(summaries: FhirUptimeSummary[]) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private initialized = false
  private serverCount = Math.max(config.fhir.serverBases.length, 1)

  private readonly servers: () => Promise<FHIRServerInfo[]>
  private readonly fetch: UpstreamFetch

  constructor(options: FhirHealthLoggerOptions = {}) {
    this.logDir = options.logDir ?? join(process.cwd(), 'logs', 'fhir-health')
    this.servers = options.servers ?? getAllServers
    this.fetch = options.fetch ?? upstreamFetch
    this.checksFile = join(this.logDir, 'health-checks.jsonl')
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true })
    }
    await this.loadRecentChecks()
    this.initialized = true
    logger.fhir.info('FHIR health logger initialized', { checksLoaded: this.checks.length })
  }

  /** Start periodic background checks. Safe to call multiple times. */
  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return
    // Run immediately then schedule
    void this.sweep()
    this.timer = setInterval(() => void this.sweep(), intervalMs)
    logger.fhir.info('FHIR health background checker started', { intervalMs })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ─── Core check logic ──────────────────────────────────────

  /** Checks every registered server once. */
  async sweep(): Promise<void> {
    const servers = await this.servers()
    if (servers.length === 0) return
    this.serverCount = servers.length

    const results = await Promise.allSettled(servers.map((server) => this.checkServer(server)))

    // Notify summary subscribers after a full sweep
    const summaries = this.getSummaries()
    for (const cb of this.summarySubscribers) {
      try { cb(summaries) } catch { /* swallow */ }
    }

    // Log any failures
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.fhir.error('Unexpected error in FHIR health check', { error: String(r.reason) })
      }
    }
  }

  /** Status of one server from its live answer to /metadata. */
  private async probe(serverUrl: string): Promise<Pick<FhirHealthCheck, 'status' | 'fhirVersion' | 'error'>> {
    try {
      const res = await this.fetch(`${serverUrl}/metadata`, {
        headers: { Accept: 'application/fhir+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (!res.ok) return { status: 'unhealthy', error: `HTTP ${res.status} from /metadata` }
      const body: unknown = await res.json().catch(() => null)
      if (!isCapabilityStatement(body)) return { status: 'degraded', error: '/metadata did not return a CapabilityStatement' }
      const fhirVersion = normalizeFHIRVersion(body.fhirVersion ?? '')
      return config.fhir.supportedVersions.includes(fhirVersion)
        ? { status: 'healthy', fhirVersion }
        : { status: 'degraded', fhirVersion, error: `FHIR ${fhirVersion} is not a supported version` }
    } catch (err) {
      return { status: 'unhealthy', error: err instanceof Error ? err.message : 'Unknown error' }
    }
  }

  private async checkServer(server: FHIRServerInfo): Promise<void> {
    const start = performance.now()
    const outcome = await this.probe(server.url)
    const check: FhirHealthCheck = {
      id: `fhir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      serverName: server.identifier,
      serverUrl: server.url,
      responseTimeMs: Math.round(performance.now() - start),
      ...outcome,
    }

    // Persist
    this.checks.unshift(check)
    if (this.checks.length > MAX_MEMORY_CHECKS * this.serverCount) {
      this.checks.length = MAX_MEMORY_CHECKS * this.serverCount
    }

    try {
      await appendFile(this.checksFile, JSON.stringify(check) + '\n', 'utf8')
    } catch (e) {
      logger.fhir.error('Failed to append FHIR health check to log', { error: String(e) })
    }

    // Notify per-check subscribers
    for (const cb of this.subscribers) {
      try { cb(check) } catch { /* swallow */ }
    }
  }

  // ─── Load persisted data ───────────────────────────────────

  private async loadRecentChecks(): Promise<void> {
    if (!existsSync(this.checksFile)) return
    try {
      const raw = await readFile(this.checksFile, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      // Keep last MAX hours regardless of server count
      const maxLines = MAX_MEMORY_CHECKS * this.serverCount
      const start = Math.max(0, lines.length - maxLines)
      for (let i = start; i < lines.length; i++) {
        try {
          const check: unknown = JSON.parse(lines[i])
          if (isHealthCheck(check)) this.checks.push(check)
        } catch { /* skip corrupt lines */ }
      }
      // Most recent first
      this.checks.reverse()
    } catch { /* file may not exist yet */ }
  }

  // ─── Query API ────────────────────────────────────────────

  getRecentChecks(opts?: { serverUrl?: string; limit?: number; since?: Date }): FhirHealthCheck[] {
    let result = this.checks
    if (opts?.serverUrl) result = result.filter(c => c.serverUrl === opts.serverUrl)
    if (opts?.since) {
      const since = opts.since.getTime()
      result = result.filter(c => new Date(c.timestamp).getTime() >= since)
    }
    if (opts?.limit) result = result.slice(0, opts.limit)
    return result
  }

  getSummaries(): FhirUptimeSummary[] {
    // Group by serverUrl
    const byUrl = new Map<string, FhirHealthCheck[]>()
    for (const c of this.checks) {
      let arr = byUrl.get(c.serverUrl)
      if (!arr) { arr = []; byUrl.set(c.serverUrl, arr) }
      arr.push(c)
    }

    const summaries: FhirUptimeSummary[] = []
    for (const [url, checks] of byUrl) {
      if (checks.length === 0) continue
      const latest = checks[0]
      const healthy = checks.filter(c => c.status === 'healthy').length
      const totalResponseTime = checks.reduce((sum, c) => sum + c.responseTimeMs, 0)
      const lastErr = checks.find(c => c.error)

      summaries.push({
        serverName: latest.serverName,
        serverUrl: url,
        currentStatus: latest.status,
        uptimePercent: Math.round((healthy / checks.length) * 10000) / 100,
        avgResponseTimeMs: Math.round(totalResponseTime / checks.length),
        checksTotal: checks.length,
        checksHealthy: healthy,
        lastChecked: latest.timestamp,
        lastError: lastErr?.error,
        recentChecks: checks.slice(0, 120), // last ~1h at 30s
      })
    }
    return summaries
  }

  // ─── Pub/Sub ──────────────────────────────────────────────

  subscribeToChecks(cb: (check: FhirHealthCheck) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  subscribeToSummaries(cb: (summaries: FhirUptimeSummary[]) => void): () => void {
    this.summarySubscribers.add(cb)
    return () => { this.summarySubscribers.delete(cb) }
  }
}

// Singleton
export const fhirHealthLogger = new FhirHealthLogger()
