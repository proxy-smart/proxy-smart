// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { mock } from 'bun:test'

export const ALLOWED_TEST_ORIGIN = 'https://app.example.com'

/** Replaces the whole cors-origins module with a single-origin policy, so every export must be here. */
export function mockCorsOriginsModule(allowed: string = ALLOWED_TEST_ORIGIN) {
  mock.module('@/lib/cors-origins', () => ({
    isOriginAllowed: (origin: string) => origin === allowed,
    allowedOrigin: (req: Request) => {
      const origin = req.headers.get('origin')
      return origin === allowed ? origin : null
    },
    getAllowedOrigins: () => [allowed],
    isPublicDiscoveryPath: () => false,
    refreshIfStale: () => {},
    refreshCorsOrigins: async () => {},
  }))
}
