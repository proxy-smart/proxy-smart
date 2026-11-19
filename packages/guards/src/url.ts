// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Linear-time `value.replace(/\/+$/, '')`; the regex is quadratic on long slash runs (ReDoS). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--
  return end === value.length ? value : value.slice(0, end)
}
