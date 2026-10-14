// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { collectSystemStatus } from '../lib/system-status'
import {
  HealthResponse,
  PublicStatusResponse,
  SystemStatusResponse,
  type HealthResponseType,
  type PublicStatusResponseType,
  type SystemStatusResponseType
} from '../schemas'

// Legacy helper removed: FHIR server health collection centralized in system-status.ts

/**
 * General server information endpoints
 */
export const statusRoutes = new Elysia({ tags: ['server', 'info', 'health'] })

  // Liveness probe — always 200 as long as the process is running.
  // Subsystem health (FHIR, Keycloak) is reported in the payload body
  // but never affects the HTTP status code. Caddy uses this to decide
  // whether to route traffic; we ALWAYS want it routed to us so we can
  // serve the landing page, admin UI, and graceful error messages.
  .get('/health', async (): Promise<HealthResponseType> => {
    try {
      const full = await collectSystemStatus();
      return {
        status: full.overall,
        timestamp: full.timestamp,
        uptime: full.uptime
      };
    } catch {
      return { status: 'degraded', timestamp: new Date().toISOString(), uptime: process.uptime() * 1000 };
    }
  }, {
    response: {
      200: HealthResponse
    },
    detail: {
      summary: 'Liveness Probe',
      description: 'Always returns 200 if the backend process is running. Subsystem health is in the response body. Use /admin/status for detailed diagnostics.',
      tags: ['server']
    }
  })

  // Public: up or down, and the version, from the cached status so callers cannot trigger probes.
  .get('/status', async (): Promise<PublicStatusResponseType> => {
    const { version, timestamp, overall } = await collectSystemStatus()
    return { version, timestamp, overall }
  }, {
    response: {
      200: PublicStatusResponse
    },
    detail: {
      summary: 'System Status',
      description: 'Whether the deployment is healthy, and its version. Subsystem detail is at /admin/status.',
      tags: ['server']
    }
  })

/** Subsystem detail, including internal upstream URLs and versions; mounted in the admin router as /admin/status. */
export const adminStatusRoutes = new Elysia({ tags: ['server'] })
  .get('/status', async (): Promise<SystemStatusResponseType> => {
    return await collectSystemStatus(true)
  }, {
    response: {
      200: SystemStatusResponse
    },
    detail: {
      summary: 'Admin System Status',
      description: 'FHIR server and Keycloak reachability, upstream versions and memory, freshly probed',
      tags: ['server']
    }
  })
