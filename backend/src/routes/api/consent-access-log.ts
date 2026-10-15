// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t } from 'elysia'
import { consentMetricsLogger } from '@/lib/consent-metrics-logger'
import { accessLogFilters, accessLogQueryFields, patientAccessEntry } from '@/lib/consent/access-log'
import { authenticateSelfPatient } from './patient-caller'
import { PatientAccessLogResponse } from '@/schemas/consent'
import { CommonErrorResponses } from '@/schemas/common'

export const consentAccessLogRoutes = new Elysia({ prefix: '/consent', tags: ['consent'] })
  .get(
    '/monitoring/access-log',
    async ({ headers, query, set }) => {
      const caller = await authenticateSelfPatient(headers, set, 'Access log')
      if ('error' in caller) return caller

      const events = consentMetricsLogger.patientAccessLog(caller.patientId, accessLogFilters(query)).map(patientAccessEntry)
      return { events, total: events.length, timestamp: new Date().toISOString() }
    },
    {
      query: t.Object(accessLogQueryFields),
      response: { 200: PatientAccessLogResponse, ...CommonErrorResponses },
      detail: {
        summary: 'My data access log',
        description: 'Who read or was refused the token patient\'s records, and when. The patient comes from the token, never from the request.',
      },
    },
  )
