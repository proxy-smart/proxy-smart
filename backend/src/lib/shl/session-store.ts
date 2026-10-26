// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, renameSync } from 'fs'
import { join } from 'path'
import { Value } from '@sinclair/typebox/value'
import { logger } from '../logger'
import { DATA_DIR } from '../paths'
import { hasDatabaseUrl } from '../pg-pool'
import { PostgresShlBackend } from './pg-backend'
import { SqliteShlBackend } from './sqlite-backend'
import {
  fromShlRow,
  toShlRow,
  ShlAccessRow,
  ShlRow,
  type ShlAttestation,
  type ShlLookupColumn,
  type ShlSession,
  type ShlSessionBackend,
} from './session'

export type { ShareScope, ShlAttestation, ShlSession, ShlWriteScope } from './session'

export interface ShlSessionStoreOptions {
  /** Runs once before the first operation, e.g. moving sessions in from an earlier backend. */
  prepare?: () => Promise<void>
}

/** SHL sessions on whichever backend the deployment has; corrupt rows never open. */
export class ShlSessionStore {
  private ready: Promise<void> | null = null

  constructor(
    private readonly backend: ShlSessionBackend,
    private readonly options: ShlSessionStoreOptions = {},
  ) {}

  async set(id: string, session: ShlSession): Promise<void> {
    await this.prepared()
    await this.backend.put(toShlRow(id, session, Date.now()))
  }

  async get(id: string): Promise<ShlSession | undefined> {
    return (await this.read('id', id))?.session
  }

  /** Reverse lookup by the viewer's bearer token. */
  async getByToken(token: string): Promise<{ id: string; session: ShlSession } | undefined> {
    return this.read('session_token', token)
  }

  async delete(id: string): Promise<void> {
    await this.prepared()
    await this.backend.remove(id)
  }

  async incrementAccessCount(id: string): Promise<void> {
    await this.prepared()
    await this.backend.incrementAccessCount(id)
  }

  /** An unseen fingerprint is a new distinct device; a repeat bumps that device's count. */
  async recordAccess(id: string, fingerprint: string): Promise<void> {
    await this.prepared()
    await this.backend.recordAccess(id, fingerprint, Date.now())
  }

  async distinctDeviceCount(id: string): Promise<number> {
    await this.prepared()
    return this.backend.distinctDevices(id)
  }

  /** Write-once, so whoever holds the link cannot re-attribute writes already made under the first signature. */
  async recordAttestation(id: string, attestation: ShlAttestation): Promise<boolean> {
    await this.prepared()
    return this.backend.recordAttestation(id, JSON.stringify(attestation))
  }

  async markConsentMirrored(id: string): Promise<void> {
    await this.prepared()
    await this.backend.markConsentMirrored(id)
  }

  /** Active sessions whose Consent mirror was never confirmed: the reconciliation sweep's work list. */
  async listUnmirroredActive(limit = 50): Promise<{ id: string; session: ShlSession }[]> {
    await this.prepared()
    const rows = await this.backend.listUnmirrored(Date.now(), limit)
    return rows.flatMap((row) => this.parse(row) ?? [])
  }

  dispose(): void {
    this.backend.dispose()
  }

  private prepared(): Promise<void> {
    this.ready ??= this.options.prepare?.() ?? Promise.resolve()
    return this.ready
  }

  private async read(column: ShlLookupColumn, value: string): Promise<{ id: string; session: ShlSession } | undefined> {
    await this.prepared()
    return this.parse(await this.backend.find(column, value))
  }

  private parse(raw: unknown): { id: string; session: ShlSession } | undefined {
    if (raw === null || raw === undefined) return undefined
    if (!Value.Check(ShlRow, raw)) {
      logger.auth.warn('SHL store: ignoring a session row with unexpected column types')
      return undefined
    }
    const session = fromShlRow(raw)
    if (!session) {
      logger.auth.warn('SHL store: ignoring a session whose stored JSON does not match its schema', { id: raw.id })
      return undefined
    }
    return { id: raw.id, session }
  }
}

/**
 * Moves the unexpired sessions of a SQLite file into Postgres, then renames the file so it runs once.
 * Never throws: on failure the file stays and the next start retries.
 */
export async function importSqliteSessions(path: string, target: PostgresShlBackend): Promise<void> {
  if (!existsSync(path)) return
  try {
    const source = new SqliteShlBackend(path, { purgeIntervalMs: 0 })
    const { sessions, accesses } = source.exportActive(Date.now())
    source.dispose()
    const rows = sessions.filter((row) => Value.Check(ShlRow, row))
    const imported = await target.importSessions(rows, accesses.filter((row) => Value.Check(ShlAccessRow, row)))
    renameSync(path, `${path}.imported`)
    logger.auth.info('SHL store: moved SQLite sessions into Postgres', { found: sessions.length, imported })
  } catch (error) {
    logger.auth.warn('SHL store: could not move SQLite sessions into Postgres, will retry on next start', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const SQLITE_PATH = process.env.SHL_DB_PATH || join(DATA_DIR, 'shl-sessions.sqlite')

function createShlSessionStore(): ShlSessionStore {
  if (!hasDatabaseUrl()) return new ShlSessionStore(new SqliteShlBackend(SQLITE_PATH))
  const backend = new PostgresShlBackend()
  return new ShlSessionStore(backend, { prepare: () => importSqliteSessions(SQLITE_PATH, backend) })
}

export const shlSessionStore = createShlSessionStore()
