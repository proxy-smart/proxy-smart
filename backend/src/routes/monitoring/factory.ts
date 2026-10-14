// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Monitoring Route Factory
 *
 * Builds a monitoring module from a list of SSE streams and a list of REST
 * endpoints. Path names, data sources and response shapes are all supplied by
 * the caller, so a module that streams `/checks` and `/summaries` composes the
 * same way as one that streams `/events` and `/analytics`.
 *
 * {@link createEventLoggerMonitoringRoutes} is the shorthand for the common case:
 * a BaseEventsLogger exposing events plus analytics on the conventional paths.
 */

import { Elysia, t, type TSchema } from 'elysia'
import { CommonErrorResponses } from '@/schemas'
import { StreamResponse } from '@/schemas/monitoring'
import type { MonitoringLogger } from '@/lib/events/journal'
import {
  createSseStream,
  requireMonitoringReader,
  setStreamHeaders,
  type MonitoringResponseSet,
  type SseSource,
} from './sse'

// ─── Specs ───────────────────────────────────────────────────────

/** One SSE endpoint: where it lives, what it streams, how it is documented. */
export interface MonitoringStreamSpec<T = unknown> extends SseSource<T> {
  /** Path within the module prefix, e.g. '/events/stream' */
  path: string
  summary: string
  description: string
}

/** One REST endpoint: where it lives, what it returns, how it is documented. */
export interface MonitoringEndpointSpec {
  /** Path within the module prefix, e.g. '/events' */
  path: string
  handler: (ctx: {
    query: Record<string, string | undefined>
    params: Record<string, string>
    set: MonitoringResponseSet
  }) => unknown | Promise<unknown>
  /** Query params this endpoint accepts (all optional strings by convention) */
  query?: Record<string, TSchema>
  /** Path params, when the path is parameterised */
  params?: Record<string, TSchema>
  /** Response schema; omit for endpoints that return a non-JSON body */
  response?: TSchema
  summary: string
  description: string
}

export interface MonitoringRoutesConfig {
  /** Route prefix, e.g. '/monitoring/auth' */
  prefix: string
  /** Tag for OpenAPI docs */
  tag: string
  streams?: MonitoringStreamSpec[]
  endpoints?: MonitoringEndpointSpec[]
}

// ─── Factory ─────────────────────────────────────────────────────

const REFUSED = { 401: CommonErrorResponses[401], 403: CommonErrorResponses[403] }

/**
 * Assemble a monitoring module from its stream and endpoint specs.
 *
 * Every route admits admin-API readers only, and both routers are mounted behind the
 * admin guard as well. They are separate because only `endpoints` joins the admin
 * router, and with it the MCP surface, which offers every GET as a read that a
 * never-ending stream cannot answer.
 */
export function createMonitoringRoutes(cfg: MonitoringRoutesConfig) {
  const streams = new Elysia({ prefix: cfg.prefix, tags: [cfg.tag] })
  const endpoints = new Elysia({ prefix: cfg.prefix, tags: [cfg.tag] })

  for (const spec of cfg.streams ?? []) {
    streams.get(spec.path, async ({ set, headers }) => {
      const refused = await requireMonitoringReader(headers, set)
      if (refused) return refused
      setStreamHeaders(set)
      return new Response(createSseStream(spec))
    }, {
      headers: t.Object({ authorization: t.Optional(t.String()) }),
      response: { 200: StreamResponse, ...REFUSED },
      detail: {
        summary: spec.summary,
        description: spec.description,
        tags: [cfg.tag],
        security: [{ BearerAuth: [] }],
      },
    })
  }

  for (const spec of cfg.endpoints ?? []) {
    endpoints.get(spec.path, async ({ query, params, headers, set }) => {
      const refused = await requireMonitoringReader(headers, set)
      if (refused) return refused
      return spec.handler({ query, params, set })
    }, {
      ...(spec.query && { query: t.Object(spec.query) }),
      ...(spec.params && { params: t.Object(spec.params) }),
      headers: t.Object({ authorization: t.Optional(t.String()) }),
      ...(spec.response && { response: { 200: spec.response, ...REFUSED } }),
      detail: {
        summary: spec.summary,
        description: spec.description,
        tags: [cfg.tag],
        security: [{ BearerAuth: [] }],
      },
    })
  }

  return { streams, endpoints }
}

export type MonitoringModule = ReturnType<typeof createMonitoringRoutes>

// ─── Event-logger shorthand ──────────────────────────────────────

export interface EventLoggerMonitoringConfig<TEvent, TAnalytics> {
  prefix: string
  tag: string
  logger: MonitoringLogger<TEvent, TAnalytics>
  connectionMessage: string
  eventsResponseSchema: TSchema
  analyticsResponseSchema: TSchema
  /** Returned by GET /analytics before the first analytics pass has run */
  emptyAnalytics: TAnalytics
  getEvents: (query: Record<string, string | undefined>) => TEvent[]
  /** Query params beyond the common limit/type/success/since set */
  extraQueryParams?: Record<string, TSchema>
  eventsStreamSummary: string
  eventsStreamDescription: string
  analyticsStreamSummary: string
  eventsGetSummary: string
  eventsGetDescription: string
  analyticsGetSummary: string
  analyticsGetDescription: string
}

/**
 * Build the conventional four-route monitoring module — events and analytics,
 * each as an SSE stream and a REST endpoint — over a BaseEventsLogger.
 */
export function createEventLoggerMonitoringRoutes<TEvent, TAnalytics>(
  cfg: EventLoggerMonitoringConfig<TEvent, TAnalytics>,
) {
  return createMonitoringRoutes({
    prefix: cfg.prefix,
    tag: cfg.tag,
    streams: [
      {
        path: '/events/stream',
        connectionMessage: cfg.connectionMessage,
        subscribe: (emit) => cfg.logger.subscribe(emit as (event: TEvent) => void),
        summary: cfg.eventsStreamSummary,
        description: cfg.eventsStreamDescription,
      },
      {
        path: '/analytics/stream',
        initial: () => cfg.logger.getAnalytics(),
        subscribe: (emit) => cfg.logger.subscribeAnalytics(emit as (analytics: TAnalytics) => void),
        summary: cfg.analyticsStreamSummary,
        description: `SSE stream of real-time ${cfg.tag} analytics updates`,
      },
    ],
    endpoints: [
      {
        path: '/events',
        handler: ({ query }) => {
          const events = cfg.getEvents(query)
          return { events, total: events.length, timestamp: new Date().toISOString() }
        },
        query: {
          limit: t.Optional(t.String()),
          type: t.Optional(t.String()),
          success: t.Optional(t.String()),
          since: t.Optional(t.String()),
          ...(cfg.extraQueryParams ?? {}),
        },
        response: cfg.eventsResponseSchema,
        summary: cfg.eventsGetSummary,
        description: cfg.eventsGetDescription,
      },
      {
        path: '/analytics',
        handler: () => {
          const analytics = cfg.logger.getAnalytics()
          return analytics
            ? { ...analytics, timestamp: new Date().toISOString() }
            : cfg.emptyAnalytics
        },
        response: cfg.analyticsResponseSchema,
        summary: cfg.analyticsGetSummary,
        description: cfg.analyticsGetDescription,
      },
    ],
  })
}
