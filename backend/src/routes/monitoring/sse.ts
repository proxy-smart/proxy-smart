// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { validateAdminToken } from '@/lib/auth'
import { AuthorizationError, extractBearerToken } from '@/lib/admin-utils'

const KEEPALIVE_INTERVAL_MS = 30_000

const encoder = new TextEncoder()

/** Minimal view of Elysia's `set`, so this file stays free of framework types. */
export interface MonitoringResponseSet {
  status?: number | string
  headers: Record<string, string | number | undefined>
}

/** `initial` returning null or undefined sends no first frame. */
export interface SseSource<T> {
  subscribe: (emit: (payload: T) => void) => () => void
  initial?: () => unknown
  connectionMessage?: string
}

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 401 or 403 as the admin guard answers; keeps the handler safe even without the guard in front. */
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

export function setStreamHeaders(set: MonitoringResponseSet): void {
  set.headers['Content-Type'] = 'text/event-stream'
  set.headers['Cache-Control'] = 'no-cache'
  set.headers['Connection'] = 'keep-alive'
}

/** Unsubscribes and stops the keepalive when the client cancels or an enqueue fails. */
export function createSseStream<T>(source: SseSource<T>): ReadableStream {
  let stop = () => {}
  return new ReadableStream({
    start(controller) {
      let active = true
      let unsubscribe = () => {}
      const keepAlive = setInterval(() => {
        send({ type: 'keepalive', timestamp: new Date().toISOString() })
      }, KEEPALIVE_INTERVAL_MS)

      stop = () => {
        if (!active) return
        active = false
        clearInterval(keepAlive)
        unsubscribe()
      }

      const send = (payload: unknown) => {
        if (!active) return
        try {
          controller.enqueue(frame(payload))
        } catch {
          stop()
        }
      }

      if (source.connectionMessage) {
        send({ type: 'connection', message: source.connectionMessage, timestamp: new Date().toISOString() })
      }

      const initial = source.initial?.()
      if (initial !== null && initial !== undefined) send(initial)
      if (!active) return

      unsubscribe = source.subscribe((payload: T) => send(payload))
      if (!active) unsubscribe()
    },
    cancel() {
      stop()
    },
  })
}
