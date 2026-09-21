// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * EHR Launch Code Tests
 *
 * Tests for the SMART App Launch 2.2.0 EHR Launch flow:
 * - POST /auth/launch → issue signed launch code
 * - GET /auth/authorize?launch=<code> → verify and resolve launch context
 * - Launch code service (sign/verify)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import jwt from 'jsonwebtoken'

// ─── Test Constants ─────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'
const TEST_PATIENT_ID = 'Patient/test-patient-123'
const TEST_ENCOUNTER_ID = 'Encounter/test-encounter-456'
const TEST_CLIENT_ID = 'smart-app-client'

// ─── Mock config via env vars ───────────────────────────────────────────────
// NOTE: Do NOT mock.module('@/config') — it's global in Bun and leaks to other
// test files. Instead, set env vars so the real config's dynamic getters pick
// them up. Save and restore in beforeEach/afterEach.
const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  SMART_LAUNCH_SECRET: TEST_LAUNCH_SECRET,
  SMART_LAUNCH_CODE_TTL_SECONDS: '300',
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'smart-health',
  KEYCLOAK_PUBLIC_URL: 'http://localhost:8080',
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
} as const

mockLoggerModule()

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  signLaunchCode as signLaunchCodeWith,
  verifyLaunchCode as verifyLaunchCodeWith,
  toLaunchCodeOptions,
  type LaunchCodePayload,
} from '@proxy-smart/auth'
import { smartProxyConfig, smartLogger } from '../src/routes/auth/smart-proxy-setup'

// smartProxyConfig reads config through getters, so options resolve per call and
// pick up the env vars each test sets.
const launchOpts = () => toLaunchCodeOptions(smartProxyConfig, smartLogger)
const signLaunchCode = (payload: LaunchCodePayload) => signLaunchCodeWith(payload, launchOpts())
const verifyLaunchCode = (code: string) => verifyLaunchCodeWith(code, launchOpts())

// ─── Launch Code Service Tests ──────────────────────────────────────────────

describe('Launch Code Service', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  describe('signLaunchCode', () => {
    it('signs a launch code with patient context', () => {
      const payload: LaunchCodePayload = {
        patient: TEST_PATIENT_ID,
      }

      const code = signLaunchCode(payload)

      expect(code).toBeTruthy()
      expect(typeof code).toBe('string')
      // Should be a valid JWT (3 dot-separated base64 segments)
      expect(code.split('.').length).toBe(3)
    })

    it('signs a launch code with full context', () => {
      const payload: LaunchCodePayload = {
        patient: TEST_PATIENT_ID,
        encounter: TEST_ENCOUNTER_ID,
        fhirUser: 'Practitioner/dr-smith',
        intent: 'order-review',
        tenant: 'hospital-a',
        needPatientBanner: true,
        smartStyleUrl: 'https://ehr.example.org/styles/smart.json',
        fhirContext: JSON.stringify([{ reference: 'ImagingStudy/123' }]),
        clientId: TEST_CLIENT_ID,
      }

      const code = signLaunchCode(payload)
      expect(code).toBeTruthy()

      // Decode without verification to check claims
      const decoded = jwt.decode(code) as Record<string, unknown>
      expect(decoded.patient).toBe(TEST_PATIENT_ID)
      expect(decoded.encounter).toBe(TEST_ENCOUNTER_ID)
      expect(decoded.fhirUser).toBe('Practitioner/dr-smith')
      expect(decoded.intent).toBe('order-review')
      expect(decoded.tenant).toBe('hospital-a')
      expect(decoded.needPatientBanner).toBe(true)
      expect(decoded.clientId).toBe(TEST_CLIENT_ID)
      expect(decoded.type).toBe('smart_launch')
      expect(decoded.iss).toBe(TEST_BASE_URL)
    })

    it('sets expiry based on configured TTL', () => {
      const code = signLaunchCode({ patient: 'P/1' })
      const decoded = jwt.decode(code) as Record<string, unknown>

      const now = Math.floor(Date.now() / 1000)
      expect(decoded.exp).toBeGreaterThan(now)
      expect(decoded.exp).toBeLessThanOrEqual(now + 300 + 2) // within 2s tolerance
    })
  })

  describe('verifyLaunchCode', () => {
    it('verifies a valid launch code and returns payload', () => {
      const payload: LaunchCodePayload = {
        patient: TEST_PATIENT_ID,
        encounter: TEST_ENCOUNTER_ID,
        intent: 'reconcile-medications',
      }

      const code = signLaunchCode(payload)
      const result = verifyLaunchCode(code)

      expect(result).not.toBeNull()
      expect(result!.payload.patient).toBe(TEST_PATIENT_ID)
      expect(result!.payload.encounter).toBe(TEST_ENCOUNTER_ID)
      expect(result!.payload.intent).toBe('reconcile-medications')
      expect(result!.remainingTtl).toBeGreaterThan(0)
      expect(result!.remainingTtl).toBeLessThanOrEqual(300)
    })

    it('returns null for expired launch code', () => {
      // Sign with 0s TTL (already expired)
      const code = jwt.sign(
        { patient: 'P/1', type: 'smart_launch' },
        TEST_LAUNCH_SECRET,
        { algorithm: 'HS256', expiresIn: -1, issuer: TEST_BASE_URL }
      )

      const result = verifyLaunchCode(code)
      expect(result).toBeNull()
    })

    it('returns null for tampered launch code', () => {
      const code = signLaunchCode({ patient: 'P/1' })
      // Tamper with the signature
      const tampered = code.slice(0, -5) + 'XXXXX'

      const result = verifyLaunchCode(tampered)
      expect(result).toBeNull()
    })

    it('returns null for wrong issuer', () => {
      const code = jwt.sign(
        { patient: 'P/1', type: 'smart_launch' },
        TEST_LAUNCH_SECRET,
        { algorithm: 'HS256', expiresIn: 300, issuer: 'http://evil.com' }
      )

      const result = verifyLaunchCode(code)
      expect(result).toBeNull()
    })

    it('returns null for wrong type claim', () => {
      const code = jwt.sign(
        { patient: 'P/1', type: 'access_token' },
        TEST_LAUNCH_SECRET,
        { algorithm: 'HS256', expiresIn: 300, issuer: TEST_BASE_URL }
      )

      const result = verifyLaunchCode(code)
      expect(result).toBeNull()
    })

    it('returns null for wrong signing key', () => {
      const code = jwt.sign(
        { patient: 'P/1', type: 'smart_launch' },
        'wrong-secret-key-totally-different',
        { algorithm: 'HS256', expiresIn: 300, issuer: TEST_BASE_URL }
      )

      const result = verifyLaunchCode(code)
      expect(result).toBeNull()
    })

    it('returns null for non-JWT garbage input', () => {
      expect(verifyLaunchCode('not-a-jwt')).toBeNull()
      expect(verifyLaunchCode('')).toBeNull()
      expect(verifyLaunchCode('abc.def.ghi')).toBeNull()
    })

    it('only includes defined fields in payload (no undefined spreading)', () => {
      const code = signLaunchCode({ patient: 'P/1' })
      const result = verifyLaunchCode(code)

      expect(result).not.toBeNull()
      expect(result!.payload.patient).toBe('P/1')
      // These should NOT be in the payload
      expect('encounter' in result!.payload).toBe(false)
      expect('fhirUser' in result!.payload).toBe(false)
      expect('intent' in result!.payload).toBe(false)
    })
  })

  describe('roundtrip', () => {
    it('preserves all context fields through sign/verify cycle', () => {
      const original: LaunchCodePayload = {
        patient: 'Patient/abc',
        encounter: 'Encounter/def',
        fhirUser: 'Practitioner/ghi',
        intent: 'summary-timeline-view',
        smartStyleUrl: 'https://example.org/style.json',
        tenant: 'tenant-xyz',
        needPatientBanner: false,
        fhirContext: JSON.stringify([{ reference: 'DiagnosticReport/456', role: 'launch' }]),
        clientId: 'my-smart-app',
      }

      const code = signLaunchCode(original)
      const result = verifyLaunchCode(code)

      expect(result).not.toBeNull()
      expect(result!.payload).toEqual(original)
    })
  })
})
