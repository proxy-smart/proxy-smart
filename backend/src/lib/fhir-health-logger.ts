// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * FHIR Server Health Logger
 *
 * Runs a periodic background health check against every configured FHIR server,
 * persists results to JSONL, and exposes an in-memory ring buffer + pub/sub
 * so the monitoring UI can query history and subscribe to real-time updates.
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'
import { config } from '../config'
import { getFHIRServerInfo, getServerIdentifier } from './fhir-utils'

// ─── Types ───────────────────────────────────────────────────────

export interface FhirHealthCheck {
  id: string
  timestamp: string
  serverName: string
  serverUrl: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  responseTimeMs: number
  fhirVersion?: string
  error?: string
}

export interface FhirUptimeSummary {
  serverName: string
  serverUrl: string
  currentStatus: 'healthy' | 'degraded' | 'unhealthy'
  uptimePercent: number
  avgResponseTimeMs: number
  checksTotal: number
  checksHealthy: number
  lastChecked: string
  lastError?: string
  /** Response-time time series (most recent first, capped) */
  recentChecks: FhirHealthCheck[]
}

// ─── Logger class ────────────────────────────────────────────────

const MAX_MEMORY_CHECKS = 2880 // ~24h at 30s intervals per server
const DEFAULT_INTERVAL_MS = 30_000

class FhirHealthLogger {
  private readonly logDir: string
  private readonly checksFile: string
  private checks: FhirHealthCheck[] = []
  private subscribers = new Set<(check: FhirHealthCheck) => void>()
  private summarySubscribers = new Set<(summaries: FhirUptimeSummary[]) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private initialized = false

  constructor() {
    this.logDir = join(process.cwd(), 'logs', 'fhir-health')
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
    void this.runAllChecks()
    this.timer = setInterval(() => void this.runAllChecks(), intervalMs)
    logger.fhir.info('FHIR health background checker started', { intervalMs })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ─── Core check logic ──────────────────────────────────────

  private async runAllChecks(): Promise<void> {
    const bases = config.fhir.serverBases
    if (bases.length === 0) return

    const results = await Promise.allSettled(
      bases.map((base, i) => this.checkServer(base, i))
    )

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

  private async checkServer(baseUrl: string, index: number): Promise<void> {
    const start = performance.now()
    let check: FhirHealthCheck

    try {
      const info = await getFHIRServerInfo(baseUrl)
      const name = getServerIdentifier(info, baseUrl, index)
      const responseTimeMs = Math.round(performance.now() - start)

      check = {
        id: `fhir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        serverName: name,
        serverUrl: baseUrl,
        status: info.supported ? 'healthy' : 'degraded',
        responseTimeMs,
        fhirVersion: info.fhirVersion,
      }
    } catch (err) {
      const responseTimeMs = Math.round(performance.now() - start)
      check = {
        id: `fhir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        serverName: `server-${index}`,
        serverUrl: baseUrl,
        status: 'unhealthy',
        responseTimeMs,
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }

    // Persist
    this.checks.unshift(check)
    if (this.checks.length > MAX_MEMORY_CHECKS * config.fhir.serverBases.length) {
      this.checks.length = MAX_MEMORY_CHECKS * config.fhir.serverBases.length
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
      const maxLines = MAX_MEMORY_CHECKS * Math.max(config.fhir.serverBases.length, 1)
      const start = Math.max(0, lines.length - maxLines)
      for (let i = start; i < lines.length; i++) {
        try {
          this.checks.push(JSON.parse(lines[i]))
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
