// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Mutual-TLS for upstream FHIR requests: certificate parsing and validation,
 * the HTTPS agent, and a fetch that uses it.
 *
 * This lived in routes/fhir-servers.ts, which meant lib/fhir-capabilities,
 * lib/ai/fhir-tools and routes/fhir all imported library code out of a route
 * module. The routes that ADMINISTER a server's mTLS config still live there
 * and call in here.
 */

import * as forge from 'node-forge'
import * as crypto from 'crypto'
import * as https from 'https'
import nodeFetch from 'node-fetch'
import { logger } from './logger'
import { mtlsStore } from './mtls-store'
import type { MtlsConfig } from '@/schemas'

/**
 * Parse certificate details from PEM content using node-forge
 * Extracts real certificate information for validation and display
 */
export function parseCertificate(certContent: string): MtlsConfig['certDetails'] {
  try {
    // Clean up the certificate content - ensure proper PEM format
    let cleanCert = certContent.trim()

    // Add headers if missing
    if (!cleanCert.includes('-----BEGIN CERTIFICATE-----')) {
      cleanCert = `-----BEGIN CERTIFICATE-----\n${cleanCert}\n-----END CERTIFICATE-----`
    }

    // Parse the certificate using node-forge
    const cert = forge.pki.certificateFromPem(cleanCert)

    // Extract subject information
    const subjectAttrs = cert.subject.attributes.map(attr =>
      `${attr.shortName || attr.name}=${attr.value}`
    ).join(', ')

    // Extract issuer information  
    const issuerAttrs = cert.issuer.attributes.map(attr =>
      `${attr.shortName || attr.name}=${attr.value}`
    ).join(', ')

    // Calculate fingerprint (SHA-256)
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
    logger.error('Failed to parse certificate', error instanceof Error ? error.message : 'Unknown error')
    throw new Error(`Invalid certificate format: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error })
  }
}

/**
 * Validate certificate chain and check for expiration
 */
export function validateCertificate(certPem: string, caCertPem?: string): { isValid: boolean, errors: string[] } {
  const errors: string[] = []

  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const now = new Date()

    // Check expiration
    if (cert.validity.notBefore > now) {
      errors.push('Certificate is not yet valid')
    }
    if (cert.validity.notAfter < now) {
      errors.push('Certificate has expired')
    }

    // Validate against CA if provided
    if (caCertPem) {
      try {
        const caCert = forge.pki.certificateFromPem(caCertPem)
        if (!caCert.verify(cert)) {
          errors.push('Certificate is not signed by the provided CA')
        }
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

/**
 * Create HTTPS agent with mTLS configuration
 * Note: This is now async due to database storage
 */
export async function createMtlsAgent(serverId: string): Promise<https.Agent | undefined> {
  const mtlsConfig = await mtlsStore.getConfig(serverId)

  if (!mtlsConfig?.enabled || !mtlsConfig.clientCert || !mtlsConfig.clientKey) {
    return undefined
  }

  try {
    // Decode base64 encoded certificates
    const cert = Buffer.from(mtlsConfig.clientCert, 'base64').toString('utf8')
    const key = Buffer.from(mtlsConfig.clientKey, 'base64').toString('utf8')
    const ca = mtlsConfig.caCert ? Buffer.from(mtlsConfig.caCert, 'base64').toString('utf8') : undefined

    // Validate certificate before using
    const validation = validateCertificate(cert, ca)
    if (!validation.isValid) {
      logger.error('mTLS certificate validation failed', validation.errors.join(', '))
      return undefined
    }

    return new https.Agent({
      cert,
      key,
      ca: ca ? [ca] : undefined,
      rejectUnauthorized: true // Always validate server certificates
    })
  } catch (error) {
    logger.error('Failed to create mTLS agent', error instanceof Error ? error.message : 'Unknown error')
    return undefined
  }
}

/**
 * Get mTLS configuration for a server (exported for use in FHIR proxy)
 */
export async function getMtlsConfig(serverId: string): Promise<MtlsConfig | undefined> {
  const config = await mtlsStore.getConfig(serverId)
  if (!config) return undefined
  
  // Convert to schema type
  return {
    enabled: config.enabled,
    clientCert: config.clientCert,
    clientKey: config.clientKey,
    caCert: config.caCert,
    certDetails: config.certDetails
  }
}

/**
 * Create a fetch function with mTLS support using node-fetch
 */
async function nodeFetchBody(body: RequestInit['body']): Promise<string | Buffer | undefined> {
  if (!body) return undefined
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body
  return Buffer.from(await new Response(body).arrayBuffer())
}

export async function fetchWithMtls(
  url: string,
  options: RequestInit & { serverId?: string } = {}
): Promise<Response> {
  const { serverId, ...fetchOptions } = options

  // Use mTLS agent if server ID provided and HTTPS URL
  if (serverId && url.startsWith('https://')) {
    const agent = await createMtlsAgent(serverId)
    if (agent) {
      logger.fhir.info('Using mTLS for FHIR request', { serverId, url: url.split('?')[0] })

      // node-fetch takes neither WHATWG streams nor Headers, so both become plain values
      const body = await nodeFetchBody(fetchOptions.body)
      const headers = fetchOptions.headers
        ? Object.fromEntries(new Headers(fetchOptions.headers).entries())
        : undefined

      const response = await nodeFetch(url, {
        method: fetchOptions.method || 'GET',
        headers,
        body,
        agent
      })

      // Convert node-fetch Response to standard Response for compatibility
      const responseBody = await response.buffer()
      return new Response(responseBody.toString(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries())
      })
    }
  }

  // Fallback to standard fetch for non-HTTPS or when mTLS not configured
  return fetch(url, fetchOptions)
}

