// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * What a user approved a client to ask for (CIMD draft §10.12). An approval is kept per resource and per redirect URI, so it
 * never carries over to another resource, nor to another place the code could be sent, such as a loopback listener.
 * Revoking a client drops its approvals and records when, so tokens it was issued before then stop being refreshed.
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

export interface ClientRevocation {
  userId: string
  clientId: string
  revokedAt: number
}

export interface ClientApprovalBackend {
  find(key: ApprovalKey): Promise<ClientApproval | null>
  /** Replaces any earlier approval under the same key. */
  save(approval: ClientApproval): Promise<void>
  forUser(userId: string): Promise<ClientApproval[]>
  /** Drops every approval the user gave the client and records the revocation; the number of approvals dropped. */
  revoke(revocation: ClientRevocation): Promise<number>
  /** When the user last revoked the client, or null. */
  revokedAt(userId: string, clientId: string): Promise<number | null>
}

const keyOf = ({ userId, clientId, resource, redirectUri }: ApprovalKey) => JSON.stringify([userId, clientId, resource, redirectUri])
const pairOf = (userId: string, clientId: string) => JSON.stringify([userId, clientId])

function isClientApproval(value: unknown): value is ClientApproval {
  if (!isRecord(value)) return false
  const { userId, clientId, resource, redirectUri, scopes, approvedAt } = value
  return typeof userId === 'string' && typeof clientId === 'string' && typeof resource === 'string' && typeof redirectUri === 'string'
    && Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string') && typeof approvedAt === 'number'
}

function isClientRevocation(value: unknown): value is ClientRevocation {
  return isRecord(value) && typeof value.userId === 'string' && typeof value.clientId === 'string' && typeof value.revokedAt === 'number'
}

const byApprovedAt = (a: ClientApproval, b: ClientApproval) => a.approvedAt - b.approvedAt

export class MemoryClientApprovalBackend implements ClientApprovalBackend {
  protected readonly approvals = new Map<string, ClientApproval>()
  protected readonly revocations = new Map<string, ClientRevocation>()

  protected changed(): void {}

  async find(key: ApprovalKey): Promise<ClientApproval | null> {
    const approval = this.approvals.get(keyOf(key))
    return approval ? structuredClone(approval) : null
  }

  async save(approval: ClientApproval): Promise<void> {
    this.approvals.set(keyOf(approval), structuredClone(approval))
    this.changed()
  }

  async forUser(userId: string): Promise<ClientApproval[]> {
    return [...this.approvals.values()].filter((approval) => approval.userId === userId).map((approval) => structuredClone(approval)).sort(byApprovedAt)
  }

  async revoke(revocation: ClientRevocation): Promise<number> {
    let dropped = 0
    for (const [key, approval] of this.approvals) {
      if (approval.userId !== revocation.userId || approval.clientId !== revocation.clientId) continue
      this.approvals.delete(key)
      dropped += 1
    }
    this.revocations.set(pairOf(revocation.userId, revocation.clientId), { ...revocation })
    this.changed()
    return dropped
  }

  async revokedAt(userId: string, clientId: string): Promise<number | null> {
    return this.revocations.get(pairOf(userId, clientId))?.revokedAt ?? null
  }
}

export class FileClientApprovalBackend extends MemoryClientApprovalBackend {
  constructor(private readonly path: string) {
    super()
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      const stored = isRecord(parsed) ? parsed : {}
      const approvals = Array.isArray(stored.approvals) ? stored.approvals.filter(isClientApproval) : []
      const revocations = Array.isArray(stored.revocations) ? stored.revocations.filter(isClientRevocation) : []
      for (const approval of approvals) this.approvals.set(keyOf(approval), approval)
      for (const revocation of revocations) this.revocations.set(pairOf(revocation.userId, revocation.clientId), revocation)
    } catch (error) {
      logger.auth.error('Could not read the client approvals file; starting empty', {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  protected override changed(): void {
    writeFileSync(this.path, JSON.stringify({ approvals: [...this.approvals.values()], revocations: [...this.revocations.values()] }), 'utf-8')
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

const APPROVAL_COLUMNS = 'user_id, client_id, resource, redirect_uri, scopes, approved_at'

function fromRow(row: ApprovalRow): ClientApproval {
  return {
    userId: row.user_id,
    clientId: row.client_id,
    resource: row.resource,
    redirectUri: row.redirect_uri,
    scopes: row.scopes.split(' ').filter(Boolean),
    approvedAt: row.approved_at.getTime(),
  }
}

export interface PostgresClientApprovalOptions {
  table?: string
  pool?: () => Pool
}

export class PostgresClientApprovalBackend implements ClientApprovalBackend {
  private ready: Promise<void> | null = null
  private readonly table: string
  private readonly revocationTable: string
  private readonly pool: () => Pool

  constructor(options: PostgresClientApprovalOptions = {}) {
    this.table = options.table ?? 'client_resource_approvals'
    this.revocationTable = `${this.table}_revocations`
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
      `CREATE TABLE IF NOT EXISTS ${this.revocationTable} (
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        revoked_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (user_id, client_id)
      )`,
    ]).catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  async find({ userId, clientId, resource, redirectUri }: ApprovalKey): Promise<ClientApproval | null> {
    await this.initialize()
    const { rows: [row] } = await this.pool().query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM ${this.table} WHERE user_id = $1 AND client_id = $2 AND resource = $3 AND redirect_uri = $4`,
      [userId, clientId, resource, redirectUri],
    )
    return row ? fromRow(row) : null
  }

  async save(approval: ClientApproval): Promise<void> {
    await this.initialize()
    await this.pool().query(
      `INSERT INTO ${this.table} (${APPROVAL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id, resource, redirect_uri) DO UPDATE SET scopes = EXCLUDED.scopes, approved_at = EXCLUDED.approved_at`,
      [approval.userId, approval.clientId, approval.resource, approval.redirectUri, approval.scopes.join(' '), new Date(approval.approvedAt)],
    )
  }

  async forUser(userId: string): Promise<ClientApproval[]> {
    await this.initialize()
    const { rows } = await this.pool().query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM ${this.table} WHERE user_id = $1 ORDER BY approved_at`,
      [userId],
    )
    return rows.map(fromRow)
  }

  async revoke({ userId, clientId, revokedAt }: ClientRevocation): Promise<number> {
    await this.initialize()
    const client = await this.pool().connect()
    try {
      await client.query('BEGIN')
      const dropped = await client.query(`DELETE FROM ${this.table} WHERE user_id = $1 AND client_id = $2`, [userId, clientId])
      await client.query(
        `INSERT INTO ${this.revocationTable} (user_id, client_id, revoked_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, client_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`,
        [userId, clientId, new Date(revokedAt)],
      )
      await client.query('COMMIT')
      return dropped.rowCount ?? 0
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async revokedAt(userId: string, clientId: string): Promise<number | null> {
    await this.initialize()
    const { rows: [row] } = await this.pool().query<{ revoked_at: Date }>(
      `SELECT revoked_at FROM ${this.revocationTable} WHERE user_id = $1 AND client_id = $2`,
      [userId, clientId],
    )
    return row ? row.revoked_at.getTime() : null
  }
}

export function createClientApprovalBackend(): ClientApprovalBackend {
  if (hasDatabaseUrl()) return new PostgresClientApprovalBackend()
  ensureDataDir()
  return new FileClientApprovalBackend(join(DATA_DIR, 'client-approvals.json'))
}

/** The one store the consent page, the connected-apps API and the token endpoint share. */
export const clientApprovals: ClientApprovalBackend = createClientApprovalBackend()
