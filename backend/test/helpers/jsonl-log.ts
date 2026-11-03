// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JournalEvent } from '../../src/lib/events/journal'

export const EVENTS_LOG = 'events.jsonl'

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** A fresh id and the current time, for building journal events. */
export function freshStamp(): JournalEvent {
  return { id: `evt-${randomSuffix()}`, timestamp: new Date().toISOString() }
}

export function writeLog(dir: string, content: string, filename = EVENTS_LOG): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), content, 'utf8')
}

/** Seed a JSONL log the way the logger would have written it, newest last. */
export function writeJsonl(dir: string, rows: readonly unknown[], filename = EVENTS_LOG): void {
  writeLog(dir, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', filename)
}

/**
 * Run a body against a directory, removed afterwards. Scoped rather than a hook pair: tests run
 * concurrently, so shared fixture state can be reseeded or deleted under a test still using it.
 */
export async function withDisposableDir<T>(dir: string, body: (dir: string) => Promise<T> | T): Promise<T> {
  try {
    return await body(dir)
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
}

/** A fresh subdirectory of ./logs, where loggers that take only a subdir name keep their files. */
export function logsSubdir(prefix: string): { subdir: string; dir: string } {
  const subdir = `${prefix}-${randomSuffix()}`
  return { subdir, dir: join(process.cwd(), 'logs', subdir) }
}
