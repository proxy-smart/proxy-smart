// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Only same-origin paths and https URLs may reach an href or src. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  if (/^\/(?![/\\])/.test(value)) return value
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

export function asset(path: string, version: string): string {
  return `${path}?v=${encodeURIComponent(version)}`
}
