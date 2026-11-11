// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { logger } from './logger'
import { createSchema, getSharedPool, hasDatabaseUrl } from './pg-pool'
import { TtlCache } from './cache/ttl-cache'

export interface MtlsConfig {
  serverId: string
  enabled: boolean
  clientCert?: string  // Base64 encoded PEM
  clientKey?: string   // Base64 encoded PEM
  caCert?: string      // Base64 encoded PEM
  certDetails?: {
    subject: string
    issuer: string
    validFrom: string
    validTo: string
    fingerprint: string
  }
  createdAt: number
  updatedAt: number
}

export interface MtlsStorageBackend {
  get(serverId: string): Promise<MtlsConfig | null>
  set(serverId: string, config: MtlsConfig): Promise<void>
  delete(serverId: string): Promise<boolean>
  list(): Promise<MtlsConfig[]>
  listExpiringCertificates(daysUntilExpiry: number): Promise<MtlsConfig[]>
}

class InMemoryMtlsStorage implements MtlsStorageBackend {
  private configs = new Map<string, MtlsConfig>()

  async get(serverId: string): Promise<MtlsConfig | null> {
    return this.configs.get(serverId) || null
  }

  async set(serverId: string, config: MtlsConfig): Promise<void> {
    this.configs.set(serverId, config)
  }

  async delete(serverId: string): Promise<boolean> {
    return this.configs.delete(serverId)
  }

  async list(): Promise<MtlsConfig[]> {
    return Array.from(this.configs.values())
  }

  async listExpiringCertificates(daysUntilExpiry: number): Promise<MtlsConfig[]> {
    const now = new Date()
    const expiryThreshold = new Date(now.getTime() + daysUntilExpiry * 24 * 60 * 60 * 1000)
    
    const expiring: MtlsConfig[] = []
    for (const config of this.configs.values()) {
      if (config.certDetails?.validTo) {
        const validTo = new Date(config.certDetails.validTo)
        if (validTo <= expiryThreshold) {
          expiring.push(config)
        }
      }
    }
    return expiring
  }
}

const NullableText = Type.Union([Type.String(), Type.Null()])
const NullableTimestamp = Type.Union([Type.Date(), Type.Null()])

const MtlsConfigRow = Type.Object({
  server_id: Type.String(),
  enabled: Type.Boolean(),
  client_cert: NullableText,
  client_key: NullableText,
  ca_cert: NullableText,
  cert_subject: NullableText,
  cert_issuer: NullableText,
  cert_valid_from: NullableTimestamp,
  cert_valid_to: NullableTimestamp,
  cert_fingerprint: NullableText,
  created_at: NullableTimestamp,
  updated_at: NullableTimestamp
})

class PostgresMtlsStorage implements MtlsStorageBackend {
  private get pool() {
    return getSharedPool()
  }
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return

    await createSchema(this.pool, 'mtls_configs', [
      `CREATE TABLE IF NOT EXISTS mtls_configs (
        server_id VARCHAR(255) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        client_cert TEXT,
        client_key TEXT,
        ca_cert TEXT,
        cert_subject VARCHAR(1024),
        cert_issuer VARCHAR(1024),
        cert_valid_from TIMESTAMP WITH TIME ZONE,
        cert_valid_to TIMESTAMP WITH TIME ZONE,
        cert_fingerprint VARCHAR(128),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_mtls_cert_expiry ON mtls_configs(cert_valid_to) WHERE enabled = true',
    ])
    this.initialized = true
    logger.info('security', 'PostgreSQL mTLS table initialized')
  }

  async get(serverId: string): Promise<MtlsConfig | null> {
    await this.initialize()
    const result = await this.pool.query(
      'SELECT * FROM mtls_configs WHERE server_id = $1',
      [serverId]
    )
    
    if (result.rows.length === 0) return null
    
    const row = result.rows[0]
    return this.rowToConfig(row)
  }

  async set(serverId: string, config: MtlsConfig): Promise<void> {
    await this.initialize()
    await this.pool.query(`
      INSERT INTO mtls_configs (
        server_id, enabled, client_cert, client_key, ca_cert,
        cert_subject, cert_issuer, cert_valid_from, cert_valid_to, cert_fingerprint,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (server_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        client_cert = EXCLUDED.client_cert,
        client_key = EXCLUDED.client_key,
        ca_cert = EXCLUDED.ca_cert,
        cert_subject = EXCLUDED.cert_subject,
        cert_issuer = EXCLUDED.cert_issuer,
        cert_valid_from = EXCLUDED.cert_valid_from,
        cert_valid_to = EXCLUDED.cert_valid_to,
        cert_fingerprint = EXCLUDED.cert_fingerprint,
        updated_at = NOW()
    `, [
      serverId,
      config.enabled,
      config.clientCert,
      config.clientKey,
      config.caCert,
      config.certDetails?.subject,
      config.certDetails?.issuer,
      config.certDetails?.validFrom,
      config.certDetails?.validTo,
      config.certDetails?.fingerprint,
      new Date(config.createdAt),
      new Date(config.updatedAt)
    ])
  }

  async delete(serverId: string): Promise<boolean> {
    await this.initialize()
    const result = await this.pool.query(
      'DELETE FROM mtls_configs WHERE server_id = $1',
      [serverId]
    )
    return (result.rowCount ?? 0) > 0
  }

  async list(): Promise<MtlsConfig[]> {
    await this.initialize()
    const result = await this.pool.query('SELECT * FROM mtls_configs ORDER BY server_id')
    return result.rows.map(row => this.rowToConfig(row))
  }

  async listExpiringCertificates(daysUntilExpiry: number): Promise<MtlsConfig[]> {
    await this.initialize()
    const result = await this.pool.query(`
      SELECT * FROM mtls_configs 
      WHERE enabled = true 
        AND cert_valid_to IS NOT NULL
        AND cert_valid_to <= NOW() + $1 * INTERVAL '1 day'
      ORDER BY cert_valid_to ASC
    `, [daysUntilExpiry])
    return result.rows.map(row => this.rowToConfig(row))
  }

  private rowToConfig(row: unknown): MtlsConfig {
    if (!Value.Check(MtlsConfigRow, row)) {
      throw new Error('mtls_configs row does not match the expected column types')
    }
    const { cert_subject, cert_issuer, cert_valid_from, cert_valid_to, cert_fingerprint } = row
    return {
      serverId: row.server_id,
      enabled: row.enabled,
      clientCert: row.client_cert ?? undefined,
      clientKey: row.client_key ?? undefined,
      caCert: row.ca_cert ?? undefined,
      certDetails: cert_subject && cert_issuer && cert_valid_from && cert_valid_to && cert_fingerprint ? {
        subject: cert_subject,
        issuer: cert_issuer,
        validFrom: cert_valid_from.toISOString(),
        validTo: cert_valid_to.toISOString(),
        fingerprint: cert_fingerprint
      } : undefined,
      createdAt: row.created_at?.getTime() ?? Date.now(),
      updatedAt: row.updated_at?.getTime() ?? Date.now()
    }
  }
}

class MtlsStore {
  private storage: MtlsStorageBackend
  private certificateExpiryWarningDays = 30
  private readonly configs = new TtlCache<MtlsConfig | null>({ ttlMs: 30_000, maxEntries: 100 })

  constructor() {
    if (hasDatabaseUrl()) {
      this.storage = new PostgresMtlsStorage()
      logger.info('security', 'mTLS store initialized with PostgreSQL backend')
    } else {
      logger.warn('security', 'No DATABASE_URL configured, using in-memory mTLS storage (data will be lost on restart)')
      this.storage = new InMemoryMtlsStorage()
    }
  }

  async getConfig(serverId: string): Promise<MtlsConfig | null> {
    return this.configs.getOrLoad(serverId, () => this.storage.get(serverId))
  }

  async getOrCreateConfig(serverId: string): Promise<MtlsConfig> {
    const existing = await this.storage.get(serverId)
    if (existing) return existing

    const newConfig: MtlsConfig = {
      serverId,
      enabled: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await this.storage.set(serverId, newConfig)
    this.configs.delete(serverId)
    return newConfig
  }

  async updateConfig(serverId: string, updates: Partial<MtlsConfig>): Promise<MtlsConfig> {
    const existing = await this.getOrCreateConfig(serverId)
    const updated: MtlsConfig = {
      ...existing,
      ...updates,
      serverId,
      updatedAt: Date.now()
    }
    await this.storage.set(serverId, updated)
    this.configs.delete(serverId)

    logger.info('security', 'mTLS configuration updated', { serverId, enabled: updated.enabled })
    return updated
  }

  async uploadCertificate(
    serverId: string, 
    type: 'client' | 'key' | 'ca', 
    content: string,
    certDetails?: MtlsConfig['certDetails']
  ): Promise<MtlsConfig> {
    await this.getOrCreateConfig(serverId)
    
    const updates: Partial<MtlsConfig> = {}
    switch (type) {
      case 'client':
        updates.clientCert = content
        if (certDetails) updates.certDetails = certDetails
        break
      case 'key':
        updates.clientKey = content
        break
      case 'ca':
        updates.caCert = content
        break
    }

    return this.updateConfig(serverId, updates)
  }

  async setEnabled(serverId: string, enabled: boolean): Promise<MtlsConfig> {
    return this.updateConfig(serverId, { enabled })
  }

  async deleteConfig(serverId: string): Promise<boolean> {
    const deleted = await this.storage.delete(serverId)
    this.configs.delete(serverId)
    if (deleted) {
      logger.info('security', 'mTLS configuration deleted', { serverId })
    }
    return deleted
  }

  async listConfigs(): Promise<MtlsConfig[]> {
    return this.storage.list()
  }

  async getExpiringCertificates(daysUntilExpiry?: number): Promise<MtlsConfig[]> {
    return this.storage.listExpiringCertificates(
      daysUntilExpiry ?? this.certificateExpiryWarningDays
    )
  }

  async hasValidConfig(serverId: string): Promise<boolean> {
    const config = await this.storage.get(serverId)
    if (!config?.enabled || !config.clientCert || !config.clientKey) {
      return false
    }

    if (config.certDetails?.validTo) {
      const validTo = new Date(config.certDetails.validTo)
      if (validTo < new Date()) {
        logger.warn('security', 'mTLS certificate has expired', { 
          serverId, 
          validTo: config.certDetails.validTo 
        })
        return false
      }
    }

    return true
  }

  async getCertificateStatus(serverId: string): Promise<{
    isValid: boolean
    daysUntilExpiry: number | null
    status: 'valid' | 'expiring_soon' | 'expired' | 'not_configured'
  }> {
    const config = await this.storage.get(serverId)
    
    if (!config?.certDetails?.validTo) {
      return { isValid: false, daysUntilExpiry: null, status: 'not_configured' }
    }

    const validTo = new Date(config.certDetails.validTo)
    const now = new Date()
    const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

    if (daysUntilExpiry < 0) {
      return { isValid: false, daysUntilExpiry, status: 'expired' }
    }

    if (daysUntilExpiry <= this.certificateExpiryWarningDays) {
      return { isValid: true, daysUntilExpiry, status: 'expiring_soon' }
    }

    return { isValid: true, daysUntilExpiry, status: 'valid' }
  }
}

export const mtlsStore = new MtlsStore()

export { MtlsConfig as MtlsConfigType }
