// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The .env text with `updates` applied: existing keys change in place, new ones are appended, all else is kept. */
export function upsertEnvContent(content: string, updates: Record<string, string>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.length > 0 ? content.replace(/\r?\n$/, '').split(/\r?\n/) : []
  const pending = new Map(Object.entries(updates))
  const updated = lines.map((line) => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]
    if (!key || !pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) updated.push(`${key}=${value}`)
  return updated.join(eol) + eol
}
