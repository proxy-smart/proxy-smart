// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Patient-facing API routes (/api/*)
 *
 * These endpoints are accessible with SMART access tokens (unlike /admin/*
 * which requires Keycloak admin tokens). Each route validates the Bearer
 * token independently.
 */

import { Elysia } from 'elysia'
import { shlRoutes } from './shl'
import { consentNotifyRoutes } from './consent-notify'
import { consentAccessLogRoutes } from './consent-access-log'

export const apiRoutes = new Elysia({ prefix: '/api' })
  .use(shlRoutes)
  .use(consentNotifyRoutes)
  .use(consentAccessLogRoutes)
