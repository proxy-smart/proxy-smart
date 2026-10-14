// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Monitoring SSE plumbing.
 *
 * Every monitoring stream in the backend is the same machine: open a
 * text/event-stream, push an optional first frame, forward everything the source
 * publishes, and keep the connection alive until the client goes away. Only the
 * source and the first frame differ, so the machine lives here once.
 */

import { validateAdminToken } from '@/lib/auth'
import { AuthorizationError, extractBearerToken } from '@/lib/admin-utils'

const KEEPALIVE_INTERVAL_MS = 30_000

const encoder = new TextEncoder()

/** Minimal view of Elysia's `set`, so this file stays free of framework types. */
export interface MonitoringResponseSet {
  status?: number | string
  headers: Record<string, string | number | undefined>
}

/**
 * A stream's data source: how to subscribe, and optionally what to send first.
 *
 * `initial` returning `null` or `undefined` sends no first frame — a "nothing
 * computed yet" snapshot is not worth a frame the client has to special-case.
 */
export interface SseSource<T> {
  subscribe: (emit: (payload: T) => void) => () => void
  initial?: () => unknown
  connectionMessage?: string
}

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Refuse anyone who may not read the admin API, answering 401 or 403 as the admin guard does.
 * The guard in front of these routes decides first; this keeps the handler safe on its own.
 */
export async function requireMonitoringReader(
  headers: Record<string, string | undefined>,
  set: MonitoringResponseSet,
): Promise<{ error: string } | null> {
  const token = extractBearerToken(headers)
  if (!token) {
    set.status = 401
    return { error: 'Unauthorized' }
  }
  try {
    await validateAdminToken(token, 'read')
    return null
  } catch (error) {
    set.status = error instanceof AuthorizationError ? 403 : 401
    return { error: error instanceof AuthorizationError ? 'Forbidden' : 'Unauthorized' }
  }
}

/** Mark the response as an event stream that no intermediary may cache or buffer. */
export function setStreamHeaders(set: MonitoringResponseSet): void {
  set.headers['Content-Type'] = 'text/event-stream'
  set.headers['Cache-Control'] = 'no-cache'
  set.headers['Connection'] = 'keep-alive'
}

/**
 * Build the SSE body for an authorised request.
 *
 * The stream unsubscribes and clears its keepalive as soon as the client stops
 * reading (`desiredSize === null`) or an enqueue throws, so a disconnected
 * client cannot leak a subscription or a timer.
 */
export function createSseStream<T>(source: SseSource<T>): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let active = true

      if (source.connectionMessage) {
        controller.enqueue(frame({
          type: 'connection',
          message: source.connectionMessage,
          timestamp: new Date().toISOString(),
        }))
      }

      const initial = source.initial?.()
      if (initial !== null && initial !== undefined) controller.enqueue(frame(initial))

      const unsubscribe = source.subscribe((payload: T) => {
        if (!active) return
        try {
          if (controller.desiredSize === null) { active = false; return }
          controller.enqueue(frame(payload))
        } catch { active = false }
      })

      const stop = () => {
        active = false
        clearInterval(keepAlive)
        unsubscribe()
      }

      const keepAlive = setInterval(() => {
        if (!active) { stop(); return }
        try {
          if (controller.desiredSize === null) { stop(); return }
          controller.enqueue(frame({ type: 'keepalive', timestamp: new Date().toISOString() }))
        } catch {
          stop()
          try { controller.close() } catch { /* already closed */ }
        }
      }, KEEPALIVE_INTERVAL_MS)

      return stop
    },
  })
}
