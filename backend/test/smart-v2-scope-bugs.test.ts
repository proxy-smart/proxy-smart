// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART v2 Scope Enforcement — Bug Regression Tests
 *
 * TDD tests that pin the correct SMART v2 behavior and catch known bugs:
 *
 * Bug 1 (smart-access-control.ts): The `isRead && (includes('r') || includes('s'))`
 *   fallback collapses the r/s distinction — .s-only scope incorrectly grants read-by-ID
 *   and .r-only incorrectly grants search.
 *
 * Bug 2 (smart-scopes.ts / isScopeGranted): v1/v2 ops interop is missing.
 *   isScopeGranted('user/Patient.s', {'user/*.read'}) returns false but should be true
 *   (v1 .read covers all v2 read-type ops: .r .s .rs).
 *   Same gap for write ops: .cu vs *.write, etc.
 */

import { describe, it, expect } from 'bun:test'
import { enforceScopeAccess } from '../src/lib/smart-access-control'
import { makeAccessContext } from './helpers/access-context'
import { useTestEnv } from './helpers/test-env'
import { isScopeGranted } from '@proxy-smart/auth'

// ── helpers ──────────────────────────────────────────────────────────────────

useTestEnv({ SCOPE_ENFORCEMENT_MODE: 'enforce' })

// ══════════════════════════════════════════════════════════════════════════════
// Bug 1 — r vs s distinction in checkSmartScopes
//
// SMART v2 spec: r = read-by-ID, s = search. They are independent.
// ══════════════════════════════════════════════════════════════════════════════

describe('Bug 1: SMART v2 r vs s must be distinct (not interchangeable)', () => {
  describe('patient/Patient.s (search-only)', () => {
    it('should ALLOW search — GET /Patient (list)', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.s' }, resourcePath: 'Patient', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should ALLOW search — GET /Patient?name=Smith', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.s' }, resourcePath: 'Patient?name=Smith', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should DENY read-by-ID — GET /Patient/123', () => {
      // .s only = search only; read-by-ID requires .r
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.s' }, resourcePath: 'Patient/123', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(false)
    })
  })

  describe('patient/Patient.r (read-by-ID only)', () => {
    it('should ALLOW read-by-ID — GET /Patient/123', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.r' }, resourcePath: 'Patient/123', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should DENY search — GET /Patient?name=Smith', () => {
      // .r only = read-by-ID only; search requires .s
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.r' }, resourcePath: 'Patient?name=Smith', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(false)
    })

    it('should DENY list — GET /Patient', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.r' }, resourcePath: 'Patient', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(false)
    })
  })

  describe('patient/Patient.rs (read+search) should allow both', () => {
    it('should ALLOW read-by-ID — GET /Patient/123', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.rs' }, resourcePath: 'Patient/123', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should ALLOW search — GET /Patient?name=x', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.rs' }, resourcePath: 'Patient?name=x', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should ALLOW list — GET /Patient', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.rs' }, resourcePath: 'Patient', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })
  })

  describe('v1 .read scope should allow both read-by-ID and search (backward compat)', () => {
    it('should ALLOW read-by-ID with v1 .read', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.read' }, resourcePath: 'Patient/123', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })

    it('should ALLOW search with v1 .read', () => {
      const ctx = makeAccessContext({ tokenPayload: { scope: 'patient/Patient.read' }, resourcePath: 'Patient?name=x', method: 'GET' })
      expect(enforceScopeAccess(ctx).allowed).toBe(true)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Bug 2 — isScopeGranted v1/v2 ops interop
//
// When the token has wildcard scopes from Keycloak (e.g. user/*.read which is v1),
// granular v2 ops (.r, .s, .rs) should still be recognised as covered.
// ══════════════════════════════════════════════════════════════════════════════

describe('Bug 2: isScopeGranted must handle v1/v2 ops interop', () => {
  describe('v1 *.read wildcard covers v2 read-type ops', () => {
    it('user/Patient.r is granted by user/*.read', () => {
      expect(isScopeGranted('user/Patient.r', new Set(['user/*.read']))).toBe(true)
    })

    it('user/Patient.s is granted by user/*.read', () => {
      expect(isScopeGranted('user/Patient.s', new Set(['user/*.read']))).toBe(true)
    })

    it('user/Patient.rs is granted by user/*.read', () => {
      expect(isScopeGranted('user/Patient.rs', new Set(['user/*.read']))).toBe(true)
    })
  })

  describe('v1 *.write wildcard covers v2 write-type ops', () => {
    it('user/Patient.c is granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.c', new Set(['user/*.write']))).toBe(true)
    })

    it('user/Patient.u is granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.u', new Set(['user/*.write']))).toBe(true)
    })

    it('user/Patient.d is granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.d', new Set(['user/*.write']))).toBe(true)
    })

    it('user/Patient.cu is granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.cu', new Set(['user/*.write']))).toBe(true)
    })

    it('user/Patient.cud is granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.cud', new Set(['user/*.write']))).toBe(true)
    })
  })

  describe('v2 .rs wildcard covers individual v2 read ops', () => {
    it('user/Patient.r is granted by user/*.rs', () => {
      expect(isScopeGranted('user/Patient.r', new Set(['user/*.rs']))).toBe(true)
    })

    it('user/Patient.s is granted by user/*.rs', () => {
      expect(isScopeGranted('user/Patient.s', new Set(['user/*.rs']))).toBe(true)
    })
  })

  describe('should NOT cross read/write boundaries', () => {
    it('user/Patient.c is NOT granted by user/*.read', () => {
      expect(isScopeGranted('user/Patient.c', new Set(['user/*.read']))).toBe(false)
    })

    it('user/Patient.r is NOT granted by user/*.write', () => {
      expect(isScopeGranted('user/Patient.r', new Set(['user/*.write']))).toBe(false)
    })
  })
})
