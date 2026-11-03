// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import * as forge from 'node-forge'
import * as crypto from 'crypto'
import { logger } from './logger'
import { mtlsStore, type MtlsConfig as StoredMtlsConfig } from './mtls-store'
import { TtlCache } from './cache/ttl-cache'
import type { MtlsConfig } from '@/schemas'

/** Parse certificate details from PEM content for validation and display. */
export function parseCertificate(certContent: string): MtlsConfig['certDetails'] {
  try {
    let cleanCert = certContent.trim()
    if (!cleanCert.includes('-----BEGIN CERTIFICATE-----')) {
      cleanCert = `-----BEGIN CERTIFICATE-----\n${cleanCert}\n-----END CERTIFICATE-----`
    }

    const cert = forge.pki.certificateFromPem(cleanCert)
    const subjectAttrs = cert.subject.attributes.map(attr => `${attr.shortName || attr.name}=${attr.value}`).join(', ')
    const issuerAttrs = cert.issuer.attributes.map(attr => `${attr.shortName || attr.name}=${attr.value}`).join(', ')

    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    const hash = crypto.createHash('sha256')
    hash.update(der, 'binary')
    const fingerprint = 'SHA256:' + hash.digest('hex').toUpperCase().match(/.{2}/g)?.join(':')

    return {
      subject: subjectAttrs,
      issuer: issuerAttrs,
      validFrom: cert.validity.notBefore.toISOString(),
      validTo: cert.validity.notAfter.toISOString(),
      fingerprint: fingerprint || 'Unknown'
    }
  } catch (error) {
    logger.security.error('Failed to parse certificate', undefined, error)
    throw new Error(`Invalid certificate format: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error })
  }
}

/** Validate a certificate's validity window and, when given, that the CA signed it. */
export function validateCertificate(certPem: string, caCertPem?: string): { isValid: boolean, errors: string[] } {
  const errors: string[] = []

  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const now = new Date()

    if (cert.validity.notBefore > now) errors.push('Certificate is not yet valid')
    if (cert.validity.notAfter < now) errors.push('Certificate has expired')

    if (caCertPem) {
      try {
        const caCert = forge.pki.certificateFromPem(caCertPem)
        if (!caCert.verify(cert)) errors.push('Certificate is not signed by the provided CA')
      } catch {
        errors.push('Invalid CA certificate format')
      }
    }

    return { isValid: errors.length === 0, errors }
  } catch (error) {
    errors.push(`Invalid certificate format: ${error instanceof Error ? error.message : 'Unknown error'}`)
    return { isValid: false, errors }
  }
}

const decodedTls = new TtlCache<BunFetchRequestInitTLS | undefined>({ ttlMs: 300_000, maxEntries: 100 })

function decode(serverId: string, mtlsConfig: StoredMtlsConfig): BunFetchRequestInitTLS | undefined {
  const key = `${serverId}:${mtlsConfig.updatedAt}`
  if (decodedTls.has(key)) return decodedTls.get(key)
  const fromBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')
  const cert = fromBase64(mtlsConfig.clientCert ?? '')
  const ca = mtlsConfig.caCert ? fromBase64(mtlsConfig.caCert) : undefined
  const validation = validateCertificate(cert, ca)
  const tls = validation.isValid ? { cert, key: fromBase64(mtlsConfig.clientKey ?? ''), ...(ca ? { ca } : {}) } : undefined
  if (!tls) logger.security.error('mTLS certificate validation failed', { serverId, errors: validation.errors })
  decodedTls.set(key, tls)
  return tls
}

/** The client certificate an admin configured for one FHIR server, as fetch TLS options. */
export async function serverTls(serverId: string): Promise<BunFetchRequestInitTLS | undefined> {
  const mtlsConfig = await mtlsStore.getConfig(serverId)
  if (!mtlsConfig?.enabled || !mtlsConfig.clientCert || !mtlsConfig.clientKey) return undefined
  return decode(serverId, mtlsConfig)
}
