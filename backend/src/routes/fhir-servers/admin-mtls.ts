// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * mTLS administration for one upstream FHIR server: read the config, toggle it,
 * upload client certificates.
 *
 * Mounted into `fhirServersAdminRoutes`, so these serve /admin/fhir-servers and
 * inherit `adminAuthGuard` with it. The mTLS machinery itself is lib/mtls.
 */

import { Elysia, t } from 'elysia'
import { logger } from '@/lib/logger'
import { validateAdminToken } from '@/lib/auth'
import { extractBearerToken } from '@/lib/admin-utils'
import { mtlsStore } from '@/lib/mtls-store'
import { parseCertificate } from '@/lib/mtls'
import { presentedIdentity } from '@/lib/upstream-fetch'
import {
  MtlsConfigResponse,
  CertificateUploadResponse,
  UpdateMtlsConfigRequest,
  UploadCertificateRequest,
  CommonErrorResponses,
  ServerIdParam,
  type MtlsConfig,
} from '@/schemas'

export const fhirServersMtlsRoutes = new Elysia({ tags: ['fhir-servers'] })
  // Get mTLS configuration for a server
  .get('/:server_id/mtls', async ({ params, set, headers }) => {
    try {
      // Require authentication
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const mtlsConfig = await mtlsStore.getConfig(params.server_id)
      const presented = await presentedIdentity(params.server_id)

      if (!mtlsConfig || !mtlsConfig.enabled) {
        return {
          enabled: false,
          hasCertificates: {
            clientCert: false,
            clientKey: false,
            caCert: false
          },
          certDetails: undefined,
          ...presented,
        }
      }

      return {
        enabled: mtlsConfig.enabled,
        hasCertificates: {
          clientCert: !!mtlsConfig.clientCert,
          clientKey: !!mtlsConfig.clientKey,
          caCert: !!mtlsConfig.caCert
        },
        certDetails: mtlsConfig.certDetails,
        ...presented,
      }
    } catch (error) {
      logger.fhir.error('Failed to get mTLS configuration', { error, serverId: params.server_id })
      set.status = 500
      return { error: 'Failed to get mTLS configuration' }
    }
  }, {
    params: ServerIdParam,
    response: {
      200: MtlsConfigResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Get mTLS Configuration',
      description: 'Get the mutual TLS configuration for a specific FHIR server',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Update mTLS configuration for a server
  .put('/:server_id/mtls', async ({ params, body, set, headers }) => {
    try {
      // Require authentication
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      const updatedConfig = await mtlsStore.setEnabled(params.server_id, body.enabled)

      return {
        success: true,
        message: 'mTLS configuration updated successfully',
        config: {
          enabled: updatedConfig.enabled,
          hasCertificates: {
            clientCert: !!updatedConfig.clientCert,
            clientKey: !!updatedConfig.clientKey,
            caCert: !!updatedConfig.caCert
          }
        }
      }
    } catch (error) {
      logger.fhir.error('Failed to update mTLS configuration', { error, serverId: params.server_id, body })
      set.status = 500
      return { error: 'Failed to update mTLS configuration' }
    }
  }, {
    params: ServerIdParam,
    body: UpdateMtlsConfigRequest,
    response: {
      200: t.Object({
        success: t.Boolean({ description: 'Whether the update was successful' }),
        message: t.String({ description: 'Success message' }),
        config: t.Object({
          enabled: t.Boolean({ description: 'Whether mTLS is enabled' }),
          hasCertificates: t.Object({
            clientCert: t.Boolean({ description: 'Whether client certificate is uploaded' }),
            clientKey: t.Boolean({ description: 'Whether client private key is uploaded' }),
            caCert: t.Boolean({ description: 'Whether CA certificate is uploaded' })
          })
        })
      }, { title: 'UpdateMtlsConfigResponse' }),
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Update mTLS Configuration',
      description: 'Enable or disable mutual TLS for a specific FHIR server',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
  // Upload certificate for mTLS
  .post('/:server_id/mtls/certificates', async ({ params, body, set, headers }) => {
    try {
      // Require authentication
      const auth = extractBearerToken(headers)
      if (!auth) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      await validateAdminToken(auth)

      // Validate certificate type
      if (!['client', 'key', 'ca'].includes(body.type)) {
        set.status = 400
        return { error: 'Invalid certificate type. Must be "client", "key", or "ca"' }
      }

      // Validate base64 content
      try {
        Buffer.from(body.content, 'base64')
      } catch {
        set.status = 400
        return { error: 'Invalid base64 content' }
      }

      // Parse certificate details for client certificates
      let certDetails: MtlsConfig['certDetails'] | undefined
      if (body.type === 'client') {
        // Decode base64 to get PEM for parsing
        const pemContent = Buffer.from(body.content, 'base64').toString('utf8')
        certDetails = parseCertificate(pemContent)
      }

      // Upload certificate using mtlsStore
      const updatedConfig = await mtlsStore.uploadCertificate(
        params.server_id,
        body.type as 'client' | 'key' | 'ca',
        body.content,
        certDetails
      )

      return {
        success: true,
        message: `${body.type === 'client' ? 'Client certificate' : body.type === 'key' ? 'Private key' : 'CA certificate'} uploaded successfully`,
        certDetails: body.type === 'client' ? updatedConfig.certDetails : undefined
      }
    } catch (error) {
      logger.fhir.error('Failed to upload certificate', { error, serverId: params.server_id })
      set.status = 500
      return { error: 'Failed to upload certificate' }
    }
  }, {
    params: ServerIdParam,
    body: UploadCertificateRequest,
    response: {
      200: CertificateUploadResponse,
      ...CommonErrorResponses
    },
    detail: {
      summary: 'Upload Certificate',
      description: 'Upload a certificate or private key for mTLS authentication',
      tags: ['servers'],
      security: [{ BearerAuth: [] }]
    }
  })
