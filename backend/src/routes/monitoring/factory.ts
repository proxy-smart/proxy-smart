// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t, type Static, type TSchema } from 'elysia'
import type { TArray, TNumber, TObject, TString } from '@sinclair/typebox'
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

export interface MonitoringStreamSpec<T = unknown> extends SseSource<T> {
  path: string
  summary: string
  description: string
}

export interface MonitoringEndpointSpec<S extends TSchema = TSchema> {
  path: string
  handler: (ctx: {
    query: Record<string, string | undefined>
    params: Record<string, string>
    set: MonitoringResponseSet
  }) => Static<S> | Promise<Static<S>>
  query?: Record<string, TSchema>
  params?: Record<string, TSchema>
  response: S
  summary: string
  description: string
}

const CHECKED = Symbol('monitoring-endpoint')

/** An endpoint whose handler the compiler has checked against its response schema. */
export type MonitoringEndpoint = MonitoringEndpointSpec & { readonly [CHECKED]: true }

export function monitoringEndpoint<S extends TSchema>(spec: MonitoringEndpointSpec<S>): MonitoringEndpoint {
  return Object.assign(spec, { [CHECKED]: true as const })
}

export interface MonitoringRoutesConfig {
  prefix: string
  tag: string
  streams?: MonitoringStreamSpec[]
  endpoints?: MonitoringEndpoint[]
}

const REFUSED = { 401: CommonErrorResponses[401], 403: CommonErrorResponses[403] }

// Two routers because only `endpoints` joins the admin router and so the MCP surface,
// where a never-ending stream cannot answer a read.
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
      response: { 200: spec.response, ...REFUSED },
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

type EventsResponseSchema<E extends TSchema> = TObject<{ events: TArray<E>; total: TNumber; timestamp: TString }>
type Unstamped<A extends TSchema> = Omit<Static<A>, 'timestamp'>

export interface EventLoggerMonitoringConfig<E extends TSchema, A extends TSchema> {
  prefix: string
  tag: string
  logger: MonitoringLogger<Static<E>, Unstamped<A>>
  connectionMessage: string
  eventsResponseSchema: EventsResponseSchema<E>
  /** Analytics as the logger computes them, stamped with a fresh timestamp on each read. */
  analyticsResponseSchema: A
  /** Returned by GET /analytics before the first analytics pass has run */
  emptyAnalytics: Unstamped<A>
  getEvents: (query: Record<string, string | undefined>) => Static<E>[]
  extraQueryParams?: Record<string, TSchema>
  eventsStreamSummary: string
  eventsStreamDescription: string
  analyticsStreamSummary: string
  eventsGetSummary: string
  eventsGetDescription: string
  analyticsGetSummary: string
  analyticsGetDescription: string
}

/** Events and analytics, each as an SSE stream and a REST endpoint, over a BaseEventsLogger. */
export function createEventLoggerMonitoringRoutes<E extends TSchema, A extends TSchema>(
  cfg: EventLoggerMonitoringConfig<E, A>,
) {
  return createMonitoringRoutes({
    prefix: cfg.prefix,
    tag: cfg.tag,
    streams: [
      {
        path: '/events/stream',
        connectionMessage: cfg.connectionMessage,
        subscribe: (emit) => cfg.logger.subscribe(emit),
        summary: cfg.eventsStreamSummary,
        description: cfg.eventsStreamDescription,
      },
      {
        path: '/analytics/stream',
        initial: () => cfg.logger.getAnalytics(),
        subscribe: (emit) => cfg.logger.subscribeAnalytics(emit),
        summary: cfg.analyticsStreamSummary,
        description: `SSE stream of real-time ${cfg.tag} analytics updates`,
      },
    ],
    endpoints: [
      monitoringEndpoint({
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
      }),
      monitoringEndpoint({
        path: '/analytics',
        handler: () => ({ ...(cfg.logger.getAnalytics() ?? cfg.emptyAnalytics), timestamp: new Date().toISOString() }),
        response: cfg.analyticsResponseSchema,
        summary: cfg.analyticsGetSummary,
        description: cfg.analyticsGetDescription,
      }),
    ],
  })
}
