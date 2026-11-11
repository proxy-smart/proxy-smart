// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { DicomStorageRefusalType } from '@/schemas'

/** The PACS storage one plan includes. */
export interface StoragePolicy {
  plan: string
  limitBytes: number
}

export interface StorageQuotas {
  limits: ReadonlyMap<string, number>
  /** Entries that are not `tier=size`, each as written. */
  invalid: string[]
}

const UNIT_BYTES: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]i?b|b)?$/

/** `500MB`, `10 GB`, `1.5TiB` or a plain byte count, in binary units; null when unreadable. */
export function parseByteSize(raw: string): number | null {
  const match = SIZE.exec(raw.trim().toLowerCase())
  if (!match) return null
  const unit = (match[2] ?? 'b').replace('ib', 'b')
  return Math.floor(Number(match[1]) * UNIT_BYTES[unit])
}

function tierKey(raw: string): string {
  return raw.trim().toLowerCase()
}

/** `free=500MB,lite=10GB,pro=100GB`: storage per tier key. Unparseable entries are reported, never guessed. */
export function parseStorageQuotas(raw: string | undefined): StorageQuotas {
  const limits = new Map<string, number>()
  const invalid: string[] = []
  for (const entry of (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=')
    const tier = separator > 0 ? tierKey(entry.slice(0, separator)) : ''
    const bytes = separator > 0 ? parseByteSize(entry.slice(separator + 1)) : null
    if (!tier || bytes === null) invalid.push(entry)
    else limits.set(tier, bytes)
  }
  return { limits, invalid }
}

/** The caller's plan, from the tier claim; null (unlimited) without a claim or a limit for its tier. */
export function storagePolicyFor(
  caller: Record<string, unknown>,
  claim: string,
  limits: ReadonlyMap<string, number>,
): StoragePolicy | null {
  const tier = caller[claim]
  if (typeof tier !== 'string' || !tier.trim()) return null
  const plan = tierKey(tier)
  const limitBytes = limits.get(plan)
  return limitBytes === undefined ? null : { plan, limitBytes }
}

/** The refusal for storing `incomingBytes` on top of `usedBytes`, or null when the plan has room. */
export function refuseStorage(policy: StoragePolicy, usedBytes: number, incomingBytes: number): DicomStorageRefusalType | null {
  if (incomingBytes <= 0 || usedBytes + incomingBytes <= policy.limitBytes) return null
  return { plan: policy.plan, usedBytes, limitBytes: policy.limitBytes, incomingBytes }
}

/**
 * Pass `body` through while it stays within the plan; past it, the stream fails and `onRefused`
 * gets the refusal, measured by the bytes streamed so far.
 */
export function meteredUploadBody(
  body: ReadableStream<Uint8Array>,
  policy: StoragePolicy,
  usedBytes: number,
  onRefused: (refusal: DicomStorageRefusalType) => void,
): ReadableStream<Uint8Array> {
  let streamed = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamed += chunk.byteLength
      const refusal = refuseStorage(policy, usedBytes, streamed)
      if (!refusal) {
        controller.enqueue(chunk)
        return
      }
      onRefused(refusal)
      controller.error(new Error(`Upload exceeds the ${policy.plan} plan's storage`))
    },
  }))
}
