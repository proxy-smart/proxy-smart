// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { basicAuth, formRequest, useTestEnv } from './helpers/test-env'
import { readJson, stubKeycloakEndpoint } from './helpers/fake-fetch'
import { TEST_ISSUER, mockAuthRouteModules, signRealmToken } from './helpers/oauth-routes'

const REVOKE_URL = `${TEST_ISSUER}/protocol/openid-connect/revoke`
const UNMATCHING_CLIENTS = { error: 'invalid_request', error_description: 'Unmatching clients' }

mockLoggerModule()
mockAuthRouteModules()

const keycloakAnswer = (status: number, body: Record<string, unknown> | '' = '') => () =>
  new Response(body === '' ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const keycloak = stubKeycloakEndpoint('revoke', keycloakAnswer(200))

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'
import { isTokenRevoked } from '../src/lib/revoked-tokens'

const exp = () => Math.floor(Date.now() / 1000) + 300

const revoke = (form: Record<string, string>, authorization?: string) =>
  authRoutes.handle(formRequest('/auth/revoke', form, authorization))

describe('POST /auth/revoke (RFC 7009)', () => {
  useTestEnv()

  beforeEach(() => {
    keycloak.reset()
  })

  it('forwards to Keycloak with the client_secret_basic header unchanged', async () => {
    const token = signRealmToken({ jti: 'rev-basic' })
    const res = await revoke({ token, token_type_hint: 'access_token' }, basicAuth('conf-app', 's3cret'))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(keycloak.calls).toHaveLength(1)
    expect(keycloak.last().url).toBe(REVOKE_URL)
    expect(keycloak.last().authorization).toBe(basicAuth('conf-app', 's3cret'))
    expect(keycloak.last().params.get('token')).toBe(token)
    expect(keycloak.last().params.get('token_type_hint')).toBe('access_token')
  })

  it('forwards client_secret_post credentials in the body', async () => {
    const res = await revoke({ token: signRealmToken({}), client_id: 'conf-app', client_secret: 's3cret' })

    expect(res.status).toBe(200)
    expect(keycloak.last().authorization).toBeNull()
    expect(keycloak.last().params.get('client_id')).toBe('conf-app')
    expect(keycloak.last().params.get('client_secret')).toBe('s3cret')
  })

  it('lets a public client revoke with only its client_id', async () => {
    const res = await revoke({ token: signRealmToken({}), client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(keycloak.last().params.get('client_id')).toBe('public-app')
  })

  it('refuses a request that names no client, without calling Keycloak', async () => {
    const res = await revoke({ token: signRealmToken({}) })

    expect(res.status).toBe(401)
    expect((await readJson(res)).error).toBe('invalid_client')
    expect(res.headers.get('www-authenticate')).toStartWith('Basic')
    expect(keycloak.calls).toHaveLength(0)
  })

  it('forgets the launch context a revoked refresh token would have carried', async () => {
    await tokenContextStore.setForRefreshToken('rt-revoke-1', { patient: 'p-1', clientId: 'public-app', exp: exp() })
    expect((await tokenContextStore.getForRefreshToken('rt-revoke-1', 'public-app'))?.patient).toBe('p-1')

    const res = await revoke({ token: signRealmToken({ jti: 'rt-revoke-1', typ: 'Refresh' }), token_type_hint: 'refresh_token', client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(await tokenContextStore.getForRefreshToken('rt-revoke-1', 'public-app')).toBeNull()
  })

  it('refuses a request without a token, without calling Keycloak', async () => {
    const res = await revoke({ client_id: 'public-app' })

    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_request')
    expect(keycloak.calls).toHaveLength(0)
  })

  it('refuses a client_assertion that does not verify, without calling Keycloak', async () => {
    const res = await revoke({
      token: signRealmToken({}),
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'not-a-jwt',
    })

    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_client')
    expect(keycloak.calls).toHaveLength(0)
  })

  it('answers 200 when Keycloak reports the token as invalid', async () => {
    keycloak.reset(keycloakAnswer(200, { error: 'invalid_token', error_description: 'Invalid token' }))

    const res = await revoke({ token: 'garbage', client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(keycloak.calls).toHaveLength(1)
  })

  it('answers 200 when Keycloak refuses the token itself with a 400 invalid_token', async () => {
    keycloak.reset(keycloakAnswer(400, { error: 'invalid_token' }))

    const res = await revoke({ token: 'garbage', client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(keycloak.calls).toHaveLength(1)
  })

  it('passes a client authentication failure through', async () => {
    keycloak.reset(keycloakAnswer(401, { error: 'invalid_client', error_description: 'Invalid client credentials' }))

    const res = await revoke({ token: signRealmToken({}) }, basicAuth('conf-app', 'wrong'))

    expect(res.status).toBe(401)
    expect((await readJson(res)).error).toBe('invalid_client')
    expect(keycloak.calls).toHaveLength(1)
  })

  it('passes a refusal for a token issued to another client through', async () => {
    keycloak.reset(keycloakAnswer(400, UNMATCHING_CLIENTS))

    const res = await revoke({ token: signRealmToken({}), client_id: 'public-app' })

    expect(res.status).toBe(400)
    expect(await readJson(res)).toEqual(UNMATCHING_CLIENTS)
  })

  it('drops the launch context stored for a revoked access token', async () => {
    await tokenContextStore.set('rev-ctx-1', { patient: 'p-1', clientId: 'public-app', exp: exp() })
    expect((await tokenContextStore.get('rev-ctx-1'))?.patient).toBe('p-1')

    const res = await revoke({ token: signRealmToken({ jti: 'rev-ctx-1', azp: 'public-app' }), client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(await tokenContextStore.get('rev-ctx-1')).toBeNull()
  })

  it('makes this proxy refuse the revoked access token from then on', async () => {
    expect(isTokenRevoked('rev-deny-1')).toBe(false)

    await revoke({ token: signRealmToken({ jti: 'rev-deny-1' }), client_id: 'public-app' })

    expect(isTokenRevoked('rev-deny-1')).toBe(true)
  })

  it('does not mark a token Keycloak refused to revoke', async () => {
    keycloak.reset(keycloakAnswer(400, UNMATCHING_CLIENTS))

    const res = await revoke({ token: signRealmToken({ jti: 'rev-deny-2' }), client_id: 'other-app' })

    expect(res.status).toBe(400)
    expect(keycloak.calls).toHaveLength(1)
    expect(isTokenRevoked('rev-deny-2')).toBe(false)
  })

  it('keeps the launch context when Keycloak refuses the revocation', async () => {
    keycloak.reset(keycloakAnswer(400, UNMATCHING_CLIENTS))
    await tokenContextStore.set('rev-ctx-2', { patient: 'p-2', clientId: 'owner-app', exp: exp() })

    const res = await revoke({ token: signRealmToken({ jti: 'rev-ctx-2', azp: 'owner-app' }), client_id: 'other-app' })

    expect(res.status).toBe(400)
    expect((await tokenContextStore.get('rev-ctx-2'))?.patient).toBe('p-2')
  })

  it('keeps the launch context bound to another client', async () => {
    await tokenContextStore.set('rev-ctx-3', { patient: 'p-3', clientId: 'owner-app', exp: exp() })

    const res = await revoke({ token: signRealmToken({ jti: 'rev-ctx-3' }) }, basicAuth('other-app', 'x'))

    expect(res.status).toBe(200)
    expect(isTokenRevoked('rev-ctx-3')).toBe(true)
    expect((await tokenContextStore.get('rev-ctx-3'))?.patient).toBe('p-3')
  })
})

describe('token context store delete', () => {
  it('removes an entry and reports whether one was there', async () => {
    await tokenContextStore.set('del-1', { patient: 'p-9', clientId: 'app', exp: exp() })

    expect(await tokenContextStore.delete('del-1', 'app')).toBe(true)
    expect(await tokenContextStore.get('del-1')).toBeNull()
    expect(await tokenContextStore.delete('del-1', 'app')).toBe(false)
  })

  it('refuses to remove an entry bound to a different client', async () => {
    await tokenContextStore.set('del-2', { patient: 'p-9', clientId: 'app', exp: exp() })

    expect(await tokenContextStore.delete('del-2', 'intruder')).toBe(false)
    expect((await tokenContextStore.get('del-2'))?.patient).toBe('p-9')
  })
})
