// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { sha256 } from '../src/lib/hash'
import { MAX_PASSCODE_ATTEMPTS, checkPasscode, hashPasscode, verifyPasscode } from '../src/lib/shl/passcode'

describe('SHL passcode hashing', () => {
  it('stores a salted argon2id hash that only the passcode verifies', async () => {
    const first = await hashPasscode('1234')
    const second = await hashPasscode('1234')
    expect(first.startsWith('$argon2id$')).toBe(true)
    expect(first).not.toBe(second)
    expect(await verifyPasscode('1234', first)).toBe(true)
    expect(await verifyPasscode('1235', first)).toBe(false)
  })

  it('still opens links minted with the earlier unsalted SHA-256', async () => {
    const legacy = sha256('1234')
    expect(await verifyPasscode('1234', legacy)).toBe(true)
    expect(await verifyPasscode('0000', legacy)).toBe(false)
  })

  it('treats an unreadable stored hash as a mismatch', async () => {
    expect(await verifyPasscode('1234', 'not-a-hash')).toBe(false)
  })
})

describe('checkPasscode', () => {
  const counter = (start = 0) => {
    let failures = start
    return { recordFailure: async () => ++failures, failures: () => failures }
  }

  it('lets a link without a passcode through', async () => {
    expect(await checkPasscode({ passcode: 'x', recordFailure: counter().recordFailure })).toEqual({ ok: true })
  })

  it('asks for the passcode without spending an attempt', async () => {
    const c = counter()
    const passcodeHash = await hashPasscode('1234')
    expect(await checkPasscode({ passcodeHash, recordFailure: c.recordFailure })).toEqual({ ok: false, status: 401, remainingAttempts: MAX_PASSCODE_ATTEMPTS })
    expect(c.failures()).toBe(0)
  })

  it('counts every wrong passcode and reports the attempts left', async () => {
    const c = counter(3)
    const passcodeHash = await hashPasscode('1234')
    const verdict = await checkPasscode({ passcodeHash, passcodeFailures: 3, passcode: '9999', recordFailure: c.recordFailure })
    expect(verdict).toEqual({ ok: false, status: 401, remainingAttempts: MAX_PASSCODE_ATTEMPTS - 4 })
  })

  it('opens with the right passcode without touching the counter', async () => {
    const c = counter(2)
    const passcodeHash = await hashPasscode('1234')
    expect(await checkPasscode({ passcodeHash, passcodeFailures: 2, passcode: '1234', recordFailure: c.recordFailure })).toEqual({ ok: true })
    expect(c.failures()).toBe(2)
  })

  it('retires the link once the attempts are spent, even for the right passcode', async () => {
    const c = counter(MAX_PASSCODE_ATTEMPTS)
    const passcodeHash = await hashPasscode('1234')
    const verdict = await checkPasscode({ passcodeHash, passcodeFailures: MAX_PASSCODE_ATTEMPTS, passcode: '1234', recordFailure: c.recordFailure })
    expect(verdict).toEqual({ ok: false, status: 404 })
    expect(c.failures()).toBe(MAX_PASSCODE_ATTEMPTS)
  })
})
