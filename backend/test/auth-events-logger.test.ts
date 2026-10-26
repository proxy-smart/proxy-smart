// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Auth Events Logger — Unit Tests
 *
 * The shared BaseEventsLogger machinery is covered once, in the shared suite.
 * What is specific to auth is its Keycloak mapping and its polled event types.
 */

import { describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AUTH_EVENT_TYPES, AuthEventsLogger, SERVICE_ACCOUNT_LOGIN, mapAuthEvent } from '../src/lib/auth-events-logger'
import { runBaseEventsLoggerSuite, runKeycloakMapperSuite } from './helpers/events-logger-suite'

runBaseEventsLoggerSuite()

runKeycloakMapperSuite({
  name: 'Auth Events Logger',
  mapEvent: mapAuthEvent,
  successType: 'LOGIN',
  errorType: 'LOGIN_ERROR',
  eventTypes: AUTH_EVENT_TYPES,
})

describe('Auth events: service-account logins', () => {
  const login = (id: string, type: string, clientId: string) => ({
    id, timestamp: new Date().toISOString(), type, clientId, success: !type.endsWith('_ERROR'),
  })

  async function withAuthLog(body: (log: AuthEventsLogger) => void | Promise<void>): Promise<void> {
    const subdir = `test-auth-events-${Math.random().toString(36).slice(2, 10)}`
    const dir = join(process.cwd(), 'logs', subdir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth-events.jsonl'), [
      login('poll-1', 'CLIENT_LOGIN', 'admin-service'),
      login('poll-2', 'CLIENT_LOGIN', 'admin-service'),
      login('broker', 'IDENTITY_PROVIDER_LOGIN_ERROR', 'patient-portal'),
      login('person', 'LOGIN', 'patient-portal'),
    ].map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    try {
      const log = new AuthEventsLogger(subdir)
      await log.initialize()
      await body(log)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('leaves them out by default, so a failed sign-in is not buried under backend polling', async () => {
    await withAuthLog(log => {
      expect(log.getRecentEvents().map(e => e.id).sort()).toEqual(['broker', 'person'])
    })
  })

  it('includes them when asked by flag, by their type or by client', async () => {
    await withAuthLog(log => {
      expect(log.getRecentEvents({ includeServiceAccounts: true })).toHaveLength(4)
      expect(log.getRecentEvents({ type: SERVICE_ACCOUNT_LOGIN })).toHaveLength(2)
      expect(log.getRecentEvents({ clientId: 'admin-service' })).toHaveLength(2)
    })
  })
})
