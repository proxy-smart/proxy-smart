// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared no-op mock for `@/lib/logger`.
 *
 * Every namespace (server, consent, fhir, ...) and top-level method resolves to
 * a no-op via a Proxy, so a partial mock never leaks a missing export into
 * another suite (bun applies `mock.module` process-globally).
 */

import { mock } from 'bun:test'

export const noop = () => {}

const noopCategory = { error: noop, warn: noop, info: noop, debug: noop, trace: noop }

export const noopLogger = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop === 'string') {
      if (['error', 'warn', 'info', 'debug', 'trace'].includes(prop)) return noop
      return noopCategory
    }
    return undefined
  },
})

// Call site must sit below the test file's imports, not run on import: bun only
// patches @/lib/logger once it has been evaluated, so an import-phase mock loses.
export function mockLoggerModule(overrides: Record<string, unknown> = {}) {
  mock.module('@/lib/logger', () => ({
    logger: noopLogger,
    createLogger: () => noopLogger,
    PerformanceTimer: class { start() {} stop() { return 0 } },
    createRequestLogger: () => ({ request: noop, response: noop }),
    ...overrides,
  }))
  return noopLogger
}
