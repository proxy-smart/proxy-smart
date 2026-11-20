// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * What a user approved a client to ask for (CIMD draft §10.12). An approval is kept per resource and per redirect URI, so it
 * never carries over to another resource, nor to another place the code could be sent, such as a loopback listener.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Pool, QueryResultRow } from 'pg'
import { logger } from './logger'
import { DATA_DIR, ensureDataDir } from './paths'
import { createSchema, getSharedPool, hasDatabaseUrl } from './pg-pool'
import { isRecord } from './type-guards'

export interface ApprovalKey {
  userId: string
  clientId: string
  /** The `aud`/`resource` the client asked for; empty when it named none. */
  resource: string
  /** Where the code went; a loopback port is part of it, so a listener on another port is asked again. */
  redirectUri: string
}

export interface ClientApproval extends ApprovalKey {
  scopes: string[]
  approvedAt: number
}

export interface ClientApprovalBackend {
  find(key: ApprovalKey): Promise<ClientApproval | null>
  /** Replaces any earlier approval under the same key. */
  save(approval: ClientApproval): Promise<void>
}

const keyOf = ({ userId, clientId, resource, redirectUri }: ApprovalKey) => JSON.stringify([userId, clientId, resource, redirectUri])

function isClientApproval(value: unknown): value is ClientApproval {
  if (!isRecord(value)) return false
  const { userId, clientId, resource, redirectUri, scopes, approvedAt } = value
  return typeof userId === 'string' && typeof clientId === 'string' && typeof resource === 'string' && typeof redirectUri === 'string'
    && Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string') && typeof approvedAt === 'number'
}

export class MemoryClientApprovalBackend implements ClientApprovalBackend {
  protected readonly approvals = new Map<string, ClientApproval>()

  protected changed(): void {}

  async find(key: ApprovalKey): Promise<ClientApproval | null> {
    const approval = this.approvals.get(keyOf(key))
    return approval ? structuredClone(approval) : null
  }

  async save(approval: ClientApproval): Promise<void> {
    this.approvals.set(keyOf(approval), structuredClone(approval))
    this.changed()
  }
}

export class FileClientApprovalBackend extends MemoryClientApprovalBackend {
  constructor(private readonly path: string) {
    super()
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      for (const approval of Array.isArray(parsed) ? parsed.filter(isClientApproval) : []) this.approvals.set(keyOf(approval), approval)
    } catch (error) {
      logger.auth.error('Could not read the client approvals file; starting empty', {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  protected override changed(): void {
    writeFileSync(this.path, JSON.stringify([...this.approvals.values()]), 'utf-8')
  }
}

interface ApprovalRow extends QueryResultRow {
  user_id: string
  client_id: string
  resource: string
  redirect_uri: string
  scopes: string
  approved_at: Date
}

export interface PostgresClientApprovalOptions {
  table?: string
  pool?: () => Pool
}

export class PostgresClientApprovalBackend implements ClientApprovalBackend {
  private ready: Promise<void> | null = null
  private readonly table: string
  private readonly pool: () => Pool

  constructor(options: PostgresClientApprovalOptions = {}) {
    this.table = options.table ?? 'client_resource_approvals'
    this.pool = options.pool ?? getSharedPool
    if (!/^[a-z_][a-z0-9_]*$/.test(this.table)) throw new Error(`Invalid client approvals table name: ${this.table}`)
  }

  private initialize(): Promise<void> {
    this.ready ??= createSchema(this.pool(), this.table, [
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        approved_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (user_id, client_id, resource, redirect_uri)
      )`,
      `CREATE INDEX IF NOT EXISTS ${this.table}_client ON ${this.table} (client_id)`,
    ]).catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  async find({ userId, clientId, resource, redirectUri }: ApprovalKey): Promise<ClientApproval | null> {
    await this.initialize()
    const { rows: [row] } = await this.pool().query<ApprovalRow>(
      `SELECT user_id, client_id, resource, redirect_uri, scopes, approved_at FROM ${this.table}
       WHERE user_id = $1 AND client_id = $2 AND resource = $3 AND redirect_uri = $4`,
      [userId, clientId, resource, redirectUri],
    )
    if (!row) return null
    return {
      userId: row.user_id,
      clientId: row.client_id,
      resource: row.resource,
      redirectUri: row.redirect_uri,
      scopes: row.scopes.split(' ').filter(Boolean),
      approvedAt: row.approved_at.getTime(),
    }
  }

  async save(approval: ClientApproval): Promise<void> {
    await this.initialize()
    await this.pool().query(
      `INSERT INTO ${this.table} (user_id, client_id, resource, redirect_uri, scopes, approved_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id, resource, redirect_uri) DO UPDATE SET scopes = EXCLUDED.scopes, approved_at = EXCLUDED.approved_at`,
      [approval.userId, approval.clientId, approval.resource, approval.redirectUri, approval.scopes.join(' '), new Date(approval.approvedAt)],
    )
  }
}

export function createClientApprovalBackend(): ClientApprovalBackend {
  if (hasDatabaseUrl()) return new PostgresClientApprovalBackend()
  ensureDataDir()
  return new FileClientApprovalBackend(join(DATA_DIR, 'client-approvals.json'))
}
