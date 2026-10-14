// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia } from 'elysia'
import { adminAuthGuard } from '@/lib/admin-auth-guard'
import { adminAuditMonitoring } from './admin-audit'
import { authMonitoring } from './auth'
import { consentMonitoring } from './consent'
import { emailMonitoring } from './email'
import { fhirMonitoring } from './fhir'
import { fhirProxyMonitoring } from './fhir-proxy'
import { oauthMonitoring } from './oauth'

/** Monitoring reads, mounted inside the admin router at /admin/monitoring. */
export const monitoringEndpointRoutes = new Elysia()
  .use(adminAuditMonitoring.endpoints)
  .use(authMonitoring.endpoints)
  .use(consentMonitoring.endpoints)
  .use(emailMonitoring.endpoints)
  .use(fhirMonitoring.endpoints)
  .use(fhirProxyMonitoring.endpoints)
  .use(oauthMonitoring.endpoints)

/** Monitoring SSE streams at /admin/monitoring, behind the same guard but outside the MCP surface. */
export const monitoringStreamRoutes = new Elysia({ prefix: '/admin' })
  .use(adminAuthGuard)
  .use(adminAuditMonitoring.streams)
  .use(authMonitoring.streams)
  .use(consentMonitoring.streams)
  .use(emailMonitoring.streams)
  .use(fhirMonitoring.streams)
  .use(fhirProxyMonitoring.streams)
  .use(oauthMonitoring.streams)
