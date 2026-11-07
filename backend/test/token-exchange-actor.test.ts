// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { fakeKcAdmin, mockKcAdminFactory } from './helpers/keycloak-admin'
import { formRequest, useTestEnv } from './helpers/test-env'
import { jsonResponse, readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { jwtClaims, mockAuthRouteModules, signRealmToken, type LoggedOAuthEvent } from './helpers/oauth-routes'

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

mockLoggerModule()
mockKcAdminFactory(async () => fakeKcAdmin().admin)

const loggedEvents: LoggedOAuthEvent[] = []
mockAuthRouteModules({
  logEvent: (event) => loggedEvents.push(event),
  validateToken: async (token, options) => {
    const claims = jwtClaims(token)
    if (options?.enforceAudience !== false && claims.aud === 'account') throw new Error('Token audience is not accepted by this resource')
    return claims
  },
})

let issued: Record<string, unknown> = {}

const issueToken = () =>
  jsonResponse({ access_token: signRealmToken(issued), token_type: 'Bearer', expires_in: 300, scope: 'openid patient/Condition.rs' })

const keycloak = stubKeycloakEndpoint('token', issueToken)

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'

const exchange = (subjectToken: string) => authRoutes.handle(formRequest('/auth/token', {
  grant_type: EXCHANGE,
  client_id: 'max-health-scribe',
  client_secret: 's',
  subject_token: subjectToken,
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
}))

const lastActorChain = () => loggedEvents[loggedEvents.length - 1]?.actorChain

describe('token exchange records who acted for whom', () => {
  useTestEnv()

  beforeEach(() => {
    loggedEvents.length = 0
    keycloak.reset()
  })

  it('stores the chain back to the portal and keeps the patient in context', async () => {
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1' }
    const res = await exchange(signRealmToken({ sub: 'u1', azp: 'patient-portal', jti: 'portal-1', patient: '1005' }))
    const data = await readJson(res)

    expect(res.status).toBe(200)
    expect(data.patient).toBe('1005')
    expect(await tokenContextStore.get('scribe-1')).toMatchObject({
      patient: '1005',
      act: { client_id: 'max-health-scribe', act: { client_id: 'patient-portal' } },
    })
    expect(lastActorChain()).toEqual(['max-health-scribe', 'patient-portal'])
  })

  it('extends an existing chain when an exchanged token is exchanged again', async () => {
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1b' }
    await exchange(signRealmToken({ sub: 'u1', azp: 'aihr', jti: 'aihr-1', patient: '1005' }))
    issued = { sub: 'u1', azp: 'summariser', jti: 'sum-1' }
    await exchange(signRealmToken({ sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1b' }))

    expect((await tokenContextStore.get('sum-1'))?.act).toEqual({
      client_id: 'summariser',
      act: { client_id: 'max-health-scribe', act: { client_id: 'aihr' } },
    })
  })

  it('does not carry the patient over when the exchange changes the subject', async () => {
    issued = { sub: 'someone-else', azp: 'max-health-scribe', jti: 'scribe-2' }
    const res = await exchange(signRealmToken({ sub: 'u1', azp: 'patient-portal', jti: 'portal-2', patient: '1005' }))
    const data = await readJson(res)

    expect(res.status).toBe(200)
    expect(data.patient).toBeUndefined()
    expect((await tokenContextStore.get('scribe-2'))?.patient).toBeUndefined()
    expect((await tokenContextStore.get('scribe-2'))?.act?.act?.client_id).toBe('patient-portal')
  })

  it('describes a token Keycloak issued for an audience no proxy resource accepts', async () => {
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-4', aud: 'account' }
    const res = await exchange(signRealmToken({ sub: 'u1', azp: 'patient-portal', jti: 'portal-4', patient: '1005', aud: 'account' }))
    const data = await readJson(res)

    expect(data.patient).toBe('1005')
    expect((await tokenContextStore.get('scribe-4'))?.act?.act?.client_id).toBe('patient-portal')
  })

  it('records nothing when Keycloak refuses the exchange', async () => {
    keycloak.reset(() => jsonResponse({ error: 'invalid_request', error_description: 'Requester is not in the audience of the subject token' }, 400))
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-3' }
    const res = await exchange(signRealmToken({ sub: 'u1', azp: 'patient-portal', jti: 'portal-3' }))

    expect(res.status).toBe(400)
    expect(keycloak.calls).toHaveLength(1)
    expect(await tokenContextStore.get('scribe-3')).toBeNull()
    expect(loggedEvents).not.toHaveLength(0)
    expect(lastActorChain()).toBeUndefined()
  })
})
