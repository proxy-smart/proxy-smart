// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { meteredUploadBody, parseByteSize, parseStorageQuotas, refuseStorage, storagePolicyFor } from '../src/lib/dicom-upload-quota'
import type { DicomStorageRefusalType } from '../src/schemas'

const MB = 1024 ** 2
const GB = 1024 ** 3

function chunks(...sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size))
      controller.close()
    },
  })
}

describe('parseByteSize', () => {
  it('reads binary units, any case, with or without a space or an i', () => {
    expect(parseByteSize('500MB')).toBe(500 * MB)
    expect(parseByteSize('10 gb')).toBe(10 * GB)
    expect(parseByteSize('1.5GiB')).toBe(1.5 * GB)
    expect(parseByteSize('2TB')).toBe(2 * 1024 * GB)
    expect(parseByteSize('4kb')).toBe(4096)
    expect(parseByteSize('1234')).toBe(1234)
    expect(parseByteSize('0')).toBe(0)
  })

  it('refuses what it cannot read', () => {
    for (const raw of ['', 'MB', '-5MB', '10 PB', 'ten GB', '1,5GB']) expect(parseByteSize(raw)).toBeNull()
  })
})

describe('parseStorageQuotas', () => {
  it('maps each tier key to its bytes', () => {
    const { limits, invalid } = parseStorageQuotas('free=500MB, Lite = 10GB ,pro=100GB')
    expect([...limits]).toEqual([['free', 500 * MB], ['lite', 10 * GB], ['pro', 100 * GB]])
    expect(invalid).toEqual([])
  })

  it('reports bad entries and keeps the good ones', () => {
    const { limits, invalid } = parseStorageQuotas('free=500MB,lite,=10GB,pro=lots')
    expect([...limits]).toEqual([['free', 500 * MB]])
    expect(invalid).toEqual(['lite', '=10GB', 'pro=lots'])
  })

  it('is empty when unset or blank', () => {
    for (const raw of [undefined, '', ' , ']) {
      const { limits, invalid } = parseStorageQuotas(raw)
      expect(limits.size).toBe(0)
      expect(invalid).toEqual([])
    }
  })
})

describe('storagePolicyFor', () => {
  const limits = new Map([['free', 500 * MB]])

  it('is the limit of the tier the claim names, matched without case', () => {
    expect(storagePolicyFor({ membership_tier: 'Free' }, 'membership_tier', limits)).toEqual({ plan: 'free', limitBytes: 500 * MB })
    expect(storagePolicyFor({ plan: 'free' }, 'plan', limits)).toEqual({ plan: 'free', limitBytes: 500 * MB })
  })

  it('is unlimited without the claim, with an unconfigured tier, or without any config', () => {
    expect(storagePolicyFor({}, 'membership_tier', limits)).toBeNull()
    expect(storagePolicyFor({ membership_tier: ['free'] }, 'membership_tier', limits)).toBeNull()
    expect(storagePolicyFor({ membership_tier: 'pro' }, 'membership_tier', limits)).toBeNull()
    expect(storagePolicyFor({ membership_tier: 'free' }, 'membership_tier', new Map())).toBeNull()
  })
})

describe('refuseStorage', () => {
  const policy = { plan: 'free', limitBytes: 1000 }

  it('admits up to the limit and nothing without bytes', () => {
    expect(refuseStorage(policy, 400, 600)).toBeNull()
    expect(refuseStorage(policy, 5000, 0)).toBeNull()
  })

  it('refuses past the limit with the fields the viewer renders', () => {
    expect(refuseStorage(policy, 400, 601)).toEqual({ plan: 'free', usedBytes: 400, limitBytes: 1000, incomingBytes: 601 })
  })
})

describe('meteredUploadBody', () => {
  const policy = { plan: 'free', limitBytes: 1000 }

  it('passes a body within the plan through unchanged', async () => {
    const refusals: DicomStorageRefusalType[] = []
    const body = meteredUploadBody(chunks(300, 300), policy, 400, (r) => refusals.push(r))
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(600)
    expect(refusals).toEqual([])
  })

  it('fails the stream at the chunk that passes the plan and reports what had streamed', async () => {
    const refusals: DicomStorageRefusalType[] = []
    const body = meteredUploadBody(chunks(300, 300, 300), policy, 400, (r) => refusals.push(r))
    await expect(new Response(body).arrayBuffer()).rejects.toThrow(/storage/)
    expect(refusals).toEqual([{ plan: 'free', usedBytes: 400, limitBytes: 1000, incomingBytes: 900 }])
  })
})
