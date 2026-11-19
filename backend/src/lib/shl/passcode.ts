// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { timingSafeEqual } from 'node:crypto'
import { sha256 } from '../hash'

export const MAX_PASSCODE_ATTEMPTS = 10

const LEGACY_SHA256 = /^[0-9a-f]{64}$/

export function hashPasscode(passcode: string): Promise<string> {
  return Bun.password.hash(passcode, { algorithm: 'argon2id' })
}

/** Links minted before argon2id stored an unsalted SHA-256; they still open until they expire. */
export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  if (LEGACY_SHA256.test(stored)) {
    return timingSafeEqual(Buffer.from(sha256(passcode), 'hex'), Buffer.from(stored, 'hex'))
  }
  try {
    return await Bun.password.verify(passcode, stored)
  } catch {
    return false
  }
}

export type PasscodeVerdict =
  | { ok: true }
  | { ok: false; status: 401; remainingAttempts: number }
  | { ok: false; status: 404 }

export interface PasscodeGateInput {
  passcodeHash?: string
  passcodeFailures?: number
  passcode?: string
  recordFailure: () => Promise<number>
}

/** SMART Health Links: a wrong passcode spends an attempt, and a link with none left is gone for good. */
export async function checkPasscode({ passcodeHash, passcodeFailures = 0, passcode, recordFailure }: PasscodeGateInput): Promise<PasscodeVerdict> {
  if (!passcodeHash) return { ok: true }
  if (passcodeFailures >= MAX_PASSCODE_ATTEMPTS) return { ok: false, status: 404 }
  if (!passcode) return { ok: false, status: 401, remainingAttempts: MAX_PASSCODE_ATTEMPTS - passcodeFailures }
  if (await verifyPasscode(passcode, passcodeHash)) return { ok: true }
  const failures = await recordFailure()
  return { ok: false, status: 401, remainingAttempts: Math.max(0, MAX_PASSCODE_ATTEMPTS - failures) }
}
