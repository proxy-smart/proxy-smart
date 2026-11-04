// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { Value } from '@sinclair/typebox/value'
import type { FHIRServerInfo } from '../src/lib/fhir-server-store'
import { FhirHealthLogger } from '../src/lib/fhir-health-logger'
import { OAuthMetricsLogger, type OAuthFlowEvent } from '../src/lib/oauth-metrics-logger'
import { FhirProxyEventSchema, MonitoringHealthResponse } from '../src/schemas/monitoring'
import { randomSuffix, withDisposableDir } from './helpers/jsonl-log'

const scratch = (name: string) => join(tmpdir(), `${name}-${randomSuffix()}`)

type FlowInput = Omit<OAuthFlowEvent, 'id' | 'timestamp'>

function flow(overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    type: 'token', status: 'success', clientId: 'app', scopes: ['openid'], grantType: 'client_credentials',
    responseTime: 100, ipAddress: '10.0.0.1', userAgent: 'test', tokenType: 'Bearer', expiresIn: 300, ...overrides,
  }
}

async function withOAuthLogger(run: (logger: OAuthMetricsLogger) => Promise<void>): Promise<void> {
  await withDisposableDir(scratch('oauth-health'), async (dir) => {
    const logger = new OAuthMetricsLogger(dir)
    await logger.initialize()
    await run(logger)
  })
}

describe.serial('OAuth health', () => {
  it('counts successes exactly and calls a quiet, working token endpoint healthy', async () => {
    await withOAuthLogger(async (logger) => {
      for (let i = 0; i < 12; i++) await logger.logEvent(flow())
      await logger.logEvent(flow({ status: 'error', errorCode: 'invalid_client' }))
      const analytics = logger.getAnalytics()
      expect(analytics?.totalFlows).toBe(13)
      expect(analytics?.successfulFlows).toBe(12)

      const health = logger.healthSnapshot()
      expect(Value.Check(MonitoringHealthResponse, health)).toBe(true)
      expect(health.oauthServer.status).toBe('healthy')
      expect(health.alerts).toEqual([])
    })
  })

  it('turns degraded, then unhealthy, as requests fail, and says how many', async () => {
    await withOAuthLogger(async (logger) => {
      for (let i = 0; i < 8; i++) await logger.logEvent(flow())
      for (let i = 0; i < 2; i++) await logger.logEvent(flow({ status: 'error' }))
      expect(logger.healthSnapshot().oauthServer.status).toBe('degraded')

      for (let i = 0; i < 10; i++) await logger.logEvent(flow({ status: 'error' }))
      const health = logger.healthSnapshot()
      expect(health.oauthServer.status).toBe('unhealthy')
      expect(health.network.status).toBe('unhealthy')
      expect(health.alerts[0]).toEqual({ type: 'error', message: '60% of the last 20 OAuth requests failed' })
    })
  })

  it('does not judge a handful of requests', async () => {
    await withOAuthLogger(async (logger) => {
      await logger.logEvent(flow({ status: 'error' }))
      await logger.logEvent(flow({ responseTime: 5000 }))
      expect(logger.healthSnapshot().oauthServer.status).toBe('healthy')
    })
  })

  it('counts only tokens that have not expired as active', async () => {
    await withOAuthLogger(async (logger) => {
      await logger.logEvent(flow({ expiresIn: 300 }))
      await logger.logEvent(flow({ expiresIn: 0 }))
      await logger.logEvent(flow({ status: 'error' }))
      await logger.logEvent(flow({ type: 'authorize' }))
      expect(logger.getAnalytics()?.activeTokens).toBe(1)
    })
  })
})

describe.serial('FHIR health checks', () => {
  const server: FHIRServerInfo = {
    name: 'HAPI', url: 'https://hapi.test/fhir', identifier: 'hapi-fhir-server',
    metadata: { fhirVersion: 'R4', serverName: 'HAPI FHIR Server', supported: true }, lastUpdated: 0,
  }
  const capability = (fhirVersion: string) => new Response(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion }), { status: 200 })

  async function sweepWith(answer: () => Promise<Response>) {
    let fetches = 0
    return withDisposableDir(scratch('fhir-health'), async (dir) => {
      const health = new FhirHealthLogger({
        logDir: dir,
        servers: async () => [server],
        fetch: () => { fetches++; return answer() },
      })
      await health.initialize()
      await health.sweep()
      await health.sweep()
      return { checks: health.getRecentChecks(), fetches }
    })
  }

  it('asks the server every time instead of reading cached metadata', async () => {
    const { checks, fetches } = await sweepWith(async () => capability('4.0.1'))
    expect(fetches).toBe(2)
    expect(checks.map((c) => c.status)).toEqual(['healthy', 'healthy'])
    expect(checks[0]).toMatchObject({ serverName: 'hapi-fhir-server', serverUrl: 'https://hapi.test/fhir', fhirVersion: 'R4' })
  })

  it('reports a server that does not answer as unhealthy, under the same name', async () => {
    const { checks } = await sweepWith(async () => { throw new Error('ECONNRESET: The socket connection was closed') })
    expect(checks[0]).toMatchObject({ status: 'unhealthy', serverName: 'hapi-fhir-server', error: 'ECONNRESET: The socket connection was closed' })
  })

  it('reports an error status as unhealthy, and a server it cannot use as degraded', async () => {
    expect((await sweepWith(async () => new Response('down', { status: 503 }))).checks[0]).toMatchObject({ status: 'unhealthy', error: 'HTTP 503 from /metadata' })
    expect((await sweepWith(async () => new Response('{}', { status: 200 }))).checks[0]?.status).toBe('degraded')
    expect((await sweepWith(async () => capability('1.0.2'))).checks[0]).toMatchObject({ status: 'degraded', fhirVersion: 'DSTU2' })
  })
})

describe('FHIR proxy events', () => {
  it('the API schema carries what the proxy records, actor chain and organization included', () => {
    const event = {
      id: 'fhir-px-1', timestamp: new Date().toISOString(), serverName: 'hapi-fhir-server', method: 'GET',
      resourcePath: 'Patient/1', resourceType: 'Patient', statusCode: 200, responseTimeMs: 12,
      clientId: 'scribe', actorChain: ['scribe', 'aihr-portal'], organizationId: 'org-1',
    }
    expect(Value.Check(FhirProxyEventSchema, event)).toBe(true)
    expect(Value.Clean(FhirProxyEventSchema, structuredClone(event))).toEqual(event)
  })
})
