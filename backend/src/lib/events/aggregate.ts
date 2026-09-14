// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Aggregations every event journal computes over its ring buffer. */

/** Sparse UTC hour key, e.g. `2026-09-04T13:00:00.000Z`. */
export function hourKey(timestamp: string, suffix = ':00:00.000Z'): string {
  return timestamp.slice(0, 13) + suffix
}

/** Sparse UTC hour buckets, oldest first. `suffix` sets key precision per dashboard. */
export function bucketByHour<TEvent extends { timestamp: string }, TBucket>(
  events: readonly TEvent[],
  create: () => TBucket,
  accumulate: (bucket: TBucket, event: TEvent) => void,
  suffix?: string,
): Array<{ hour: string } & TBucket> {
  const buckets = new Map<string, TBucket>()

  for (const event of events) {
    const hour = hourKey(event.timestamp, suffix)
    let bucket = buckets.get(hour)
    if (!bucket) {
      bucket = create()
      buckets.set(hour, bucket)
    }
    accumulate(bucket, event)
  }

  return Array.from(buckets.entries())
    .map(([hour, bucket]) => ({ hour, ...bucket }))
    .sort((a, b) => a.hour.localeCompare(b.hour))
}

/** Count events by a string key, skipping events the key does not apply to. */
export function countBy<TEvent>(
  events: readonly TEvent[],
  key: (event: TEvent) => string | null | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) {
    const k = key(event)
    if (k === null || k === undefined || k === '') continue
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}

/** Tally by a string key into a Map, for callers that then rank it. */
export function tallyBy<TEvent>(
  events: readonly TEvent[],
  key: (event: TEvent) => string | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    const k = key(event)
    if (k === null || k === undefined || k === '') continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

/** Highest counts first, capped at `limit`. */
export function topEntries(counts: Map<string, number>, limit = 10): Array<[string, number]> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

export interface PercentOptions {
  /** Returned when `total` is 0. Defaults to 0. */
  fallback?: number
  /** Round to two decimals. Off by default, matching the raw-ratio dashboards. */
  round?: boolean
}

export function percent(part: number, total: number, options?: PercentOptions): number {
  if (total <= 0) return options?.fallback ?? 0
  const value = (part / total) * 100
  return options?.round ? Math.round(value * 100) / 100 : value
}

export function average(values: readonly number[], options?: { round?: boolean }): number {
  if (values.length === 0) return 0
  const sum = values.reduce((acc, value) => acc + value, 0)
  const value = sum / values.length
  return options?.round ? Math.round(value) : value
}
