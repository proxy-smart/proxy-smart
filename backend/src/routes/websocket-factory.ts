// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * WebSocket Monitoring Factory
 *
 * Creates Elysia WebSocket monitoring endpoints with a consistent pattern:
 * - Token-based authentication
 * - Subscribe/unsubscribe to events & analytics streams
 * - Client-side filtering
 * - Control actions (clear_logs, export_logs, etc.)
 * - Broadcast utility
 *
 * Each domain (OAuth, Consent, etc.) provides its logger, filter logic,
 * and control action handlers.
 */

import { Elysia } from 'elysia'
import { validateToken } from '../lib/auth'
import { logger } from '../lib/logger'
import type { MonitoringLogger } from '../lib/events/journal'
import {
  WebSocketInfoResponse,
  type WebSocketClient,
  type WebSocketMessageType,
  type ControlMessageType,
} from '../schemas/websocket'


// ─── Factory configuration ───────────────────────────────────────

export interface WebSocketFactoryConfig<TEvent, TAnalytics> {
  /** URL prefix, e.g. '/oauth/monitoring' */
  prefix: string
  /** Human-readable channel name for logs, e.g. 'OAuth' */
  channel: string
  /** OpenAPI tag for the info endpoint */
  tag: string
  /** The metrics logger instance */
  metricsLogger: MonitoringLogger<TEvent, TAnalytics>
  /** Subscription types exposed to clients */
  subscriptionTypes: string[]
  /** Apply client-side filters to events */
  applyEventFilters: (events: TEvent[], filters: WebSocketClient['filters']) => TEvent[]
  /** Execute domain-specific control actions */
  executeControlAction: (control: ControlMessageType, metricsLogger: MonitoringLogger<TEvent, TAnalytics>) => Promise<Record<string, unknown>>
  /** Optional: setup a 'logs' subscription (oauth has this, consent does not) */
  setupLogSubscription?: (client: WebSocketClient) => void
}

// ─── Shared event filtering ──────────────────────────────────────

export function createEventFilter<TEvent>(
  typeOf: (event: TEvent) => string,
  timestampOf: (event: TEvent) => string,
): (events: TEvent[], filters: WebSocketClient['filters']) => TEvent[] {
  return (events, filters) => {
    let filtered = events

    const eventTypes = filters.eventTypes
    if (eventTypes && eventTypes.length > 0) {
      filtered = filtered.filter(event => eventTypes.includes(typeOf(event)))
    }

    const timeRange = filters.timeRange
    if (timeRange) {
      filtered = filtered.filter(event => {
        const eventTime = new Date(timestampOf(event))
        return eventTime >= timeRange.start && eventTime <= timeRange.end
      })
    }

    return filtered
  }
}

// ─── Shared control actions ──────────────────────────────────────

export interface BaseControlActionOptions {
  /** Domain-specific message logged for clear_logs */
  clearLogsMessage: string
}

export async function executeBaseControlAction<TEvent, TAnalytics>(
  control: ControlMessageType,
  metricsLogger: MonitoringLogger<TEvent, TAnalytics>,
  options: BaseControlActionOptions,
): Promise<Record<string, unknown>> {
  switch (control.action) {
    case 'clear_logs':
      logger.ws.info(options.clearLogsMessage)
      return { cleared: true, timestamp: new Date().toISOString() }

    case 'export_logs': {
      const events = metricsLogger.getRecentEvents({ limit: 1000 })
      const analytics = metricsLogger.getAnalytics()
      return { events, analytics, exportedAt: new Date().toISOString() }
    }

    default:
      throw new Error(`Unknown control action: ${control.action}`)
  }
}

export function createControlActionHandler<TEvent, TAnalytics>(
  options: BaseControlActionOptions,
): (control: ControlMessageType, metricsLogger: MonitoringLogger<TEvent, TAnalytics>) => Promise<Record<string, unknown>> {
  return (control, metricsLogger) => executeBaseControlAction(control, metricsLogger, options)
}

// ─── Factory function ────────────────────────────────────────────

export function createMonitoringWebSocket<TEvent, TAnalytics>(
  config: WebSocketFactoryConfig<TEvent, TAnalytics>,
) {
  const clients = new Map<string, WebSocketClient>()

  function generateClientId(): string {
    return `${config.channel.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  function findClientByWs(ws: unknown): WebSocketClient | undefined {
    for (const client of clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  // ── Message handlers ───────────────────────────────────────────

  async function handleAuth(client: WebSocketClient, message: WebSocketMessageType) {
    if (!message.token) {
      client.ws.send(JSON.stringify({ type: 'auth_error', data: { message: 'Token required' } }))
      return
    }

    try {
      await validateToken(message.token)
      client.authenticated = true
      logger.ws.info(`${config.channel} monitoring WebSocket client authenticated`, { clientId: client.id })
      client.ws.send(JSON.stringify({
        type: 'auth_success',
        data: { message: 'Authentication successful', timestamp: new Date().toISOString() },
      }))
    } catch {
      logger.ws.warn(`${config.channel} monitoring WebSocket authentication failed`, { clientId: client.id })
      client.ws.send(JSON.stringify({ type: 'auth_error', data: { message: 'Invalid token' } }))
    }
  }

  function handleSubscribe(client: WebSocketClient, message: WebSocketMessageType) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Authentication required' } }))
      return
    }

    const subscriptionType = (message.data as Record<string, unknown>)?.subscriptionType as string
    if (!subscriptionType) {
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Subscription type required' } }))
      return
    }

    client.subscriptions.add(subscriptionType)

    switch (subscriptionType) {
      case 'events':
        setupEventSubscription(client)
        break
      case 'analytics':
        setupAnalyticsSubscription(client)
        break
      case 'logs':
        config.setupLogSubscription?.(client)
        break
    }

    client.ws.send(JSON.stringify({
      type: 'subscription_confirmed',
      data: { subscriptionType, timestamp: new Date().toISOString() },
    }))

    logger.ws.info(`${config.channel} monitoring WebSocket subscription added`, { clientId: client.id, subscriptionType })
  }

  function handleUnsubscribe(client: WebSocketClient, message: WebSocketMessageType) {
    const subscriptionType = (message.data as Record<string, unknown>)?.subscriptionType as string
    if (subscriptionType) {
      client.subscriptions.delete(subscriptionType)
      client.ws.send(JSON.stringify({
        type: 'unsubscription_confirmed',
        data: { subscriptionType, timestamp: new Date().toISOString() },
      }))
    }
  }

  function handleFilter(client: WebSocketClient, message: WebSocketMessageType) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Authentication required' } }))
      return
    }

    const filters = (message.data as Record<string, unknown>)?.filters
    if (filters) {
      client.filters = { ...client.filters, ...filters }
      client.ws.send(JSON.stringify({
        type: 'filter_updated',
        data: { filters: client.filters, timestamp: new Date().toISOString() },
      }))
    }
  }

  async function handleControl(client: WebSocketClient, message: WebSocketMessageType) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Authentication required' } }))
      return
    }

    const control = message.data as unknown as ControlMessageType
    if (!control?.action) {
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Control data required' } }))
      return
    }

    try {
      const result = await config.executeControlAction(control, config.metricsLogger)
      client.ws.send(JSON.stringify({
        type: 'control_result',
        data: { action: control.action, result, timestamp: new Date().toISOString() },
      }))
    } catch {
      client.ws.send(JSON.stringify({
        type: 'control_error',
        data: { action: control.action, message: 'Control action failed' },
      }))
    }
  }

  function handlePing(client: WebSocketClient) {
    client.ws.send(JSON.stringify({
      type: 'pong',
      data: { timestamp: new Date().toISOString(), clientId: client.id },
    }))
  }

  async function handleMessage(client: WebSocketClient, message: WebSocketMessageType) {
    try {
      switch (message.type) {
        case 'auth': await handleAuth(client, message); break
        case 'subscribe': handleSubscribe(client, message); break
        case 'unsubscribe': handleUnsubscribe(client, message); break
        case 'filter': handleFilter(client, message); break
        case 'control': await handleControl(client, message); break
        case 'ping': handlePing(client); break
        default:
          client.ws.send(JSON.stringify({ type: 'error', data: { message: `Unknown message type: ${message.type}` } }))
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.ws.error(`Failed to handle ${config.channel} WebSocket message`, {
        error: errorMessage,
        clientId: client.id,
        messageType: message.type,
      })
      client.ws.send(JSON.stringify({ type: 'error', data: { message: 'Internal server error' } }))
    }
  }

  // ── Subscription setup ─────────────────────────────────────────

  function setupEventSubscription(client: WebSocketClient) {
    const recentEvents = config.metricsLogger.getRecentEvents({ limit: 50 })
    const filteredEvents = config.applyEventFilters(recentEvents, client.filters)
    client.ws.send(JSON.stringify({ type: 'events_data', data: { events: filteredEvents } }))

    config.metricsLogger.subscribe((event) => {
      if (client.subscriptions.has('events') && client.authenticated) {
        const filtered = config.applyEventFilters([event], client.filters)
        if (filtered.length > 0) {
          client.ws.send(JSON.stringify({ type: 'events_update', data: { event: filtered[0] } }))
        }
      }
    })
  }

  function setupAnalyticsSubscription(client: WebSocketClient) {
    const analytics = config.metricsLogger.getAnalytics()
    client.ws.send(JSON.stringify({ type: 'analytics_data', data: analytics }))

    config.metricsLogger.subscribeAnalytics((analytics) => {
      if (client.subscriptions.has('analytics') && client.authenticated) {
        client.ws.send(JSON.stringify({ type: 'analytics_update', data: analytics }))
      }
    })
  }

  // ── Broadcast utility (returned for external use) ──────────────

  function broadcast(type: string, data: Record<string, unknown>) {
    const message = JSON.stringify({ type, data })
    for (const client of clients.values()) {
      if (client.authenticated && client.ws.readyState === 1) {
        try {
          client.ws.send(message)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          logger.ws.error(`Failed to broadcast to ${config.channel} WebSocket client`, {
            error: errorMessage,
            clientId: client.id,
          })
        }
      }
    }
  }

  // ── Build Elysia plugin ────────────────────────────────────────

  const plugin = new Elysia({ prefix: config.prefix })
    .ws('/websocket', {
      perMessageDeflate: true,

      open(ws) {
        const clientId = generateClientId()
        const client: WebSocketClient = {
          id: clientId,
          ws,
          authenticated: false,
          subscriptions: new Set(),
          filters: {},
        }
        clients.set(clientId, client)
        logger.ws.info(`${config.channel} monitoring WebSocket connection opened`, { clientId })
        ws.send(JSON.stringify({
          type: 'welcome',
          data: { clientId, timestamp: new Date().toISOString() },
        }))
      },

      message(ws, message) {
        let parsedMessage: WebSocketMessageType
        try {
          parsedMessage = typeof message === 'string' ? JSON.parse(message) : message
        } catch {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message format' } }))
          return
        }

        let client = parsedMessage.clientId ? clients.get(parsedMessage.clientId) : null
        if (!client) client = findClientByWs(ws)

        if (!client) {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Client not found' } }))
          return
        }

        handleMessage(client, parsedMessage)
      },

      close(ws) {
        const client = findClientByWs(ws)
        if (client) {
          logger.ws.info(`${config.channel} monitoring WebSocket connection closed`, { clientId: client.id })
          clients.delete(client.id)
        }
      },
    })
    .get('/websocket/info', () => ({
      endpoint: `${config.prefix}/websocket`,
      protocol: 'ws',
      supportedMessages: ['auth', 'subscribe', 'unsubscribe', 'filter', 'control', 'ping'],
      subscriptionTypes: config.subscriptionTypes,
    }), {
      response: { 200: WebSocketInfoResponse },
      detail: {
        summary: `${config.channel} WebSocket Connection Info`,
        description: `Get information about ${config.channel} monitoring WebSocket endpoint`,
        tags: [config.tag],
      },
    })

  return { plugin, broadcast }
}
