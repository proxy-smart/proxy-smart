// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, beforeEach } from 'bun:test'

export const TEST_BASE_URL = 'http://localhost:8445'
export const TEST_KC_BASE_URL = 'http://localhost:8080'
export const TEST_REALM = 'smart-health'
export const TEST_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'

export type TestEnv = Readonly<Record<string, string | undefined>>

export const BASE_TEST_ENV = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  SMART_LAUNCH_SECRET: TEST_LAUNCH_SECRET,
  FHIR_BASE_URL: 'http://localhost:8081/fhir',
  PROXY_NAME: 'fhir',
} as const

export type BaseTestEnvKey = keyof typeof BASE_TEST_ENV

export function omitTestEnv(...keys: BaseTestEnvKey[]): TestEnv {
  const omitted = new Set<string>(keys)
  return Object.fromEntries(Object.entries(BASE_TEST_ENV).filter(([key]) => !omitted.has(key)))
}

/** Sets each key, or unsets it when the value is undefined. */
export function applyEnv(env: TestEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** A request to the backend under test, addressed by path. */
export function testRequest(path: string, init?: RequestInit): Request {
  return new Request(`${TEST_BASE_URL}${path}`, init)
}

// Feeds the real config's env getters (mocking @/config leaks across files). Hooks bind to the calling describe; undefined unsets.
export function useTestEnv(env: TestEnv = BASE_TEST_ENV): void {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of Object.keys(env)) saved[key] = process.env[key]
    applyEnv(env)
  })

  afterEach(() => {
    applyEnv(saved)
  })
}
