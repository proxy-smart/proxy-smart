// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** No-op @/lib/logger mock: every namespace and method resolves to a no-op, so no suite leaks a missing export. */

import { mock } from 'bun:test'

export const noop = () => {}

const noopCategory = { error: noop, warn: noop, info: noop, debug: noop, trace: noop }

export const noopLogger = new Proxy<Record<string, unknown>>({}, {
  get(_target, prop) {
    if (typeof prop === 'string') {
      if (['error', 'warn', 'info', 'debug', 'trace'].includes(prop)) return noop
      return noopCategory
    }
    return undefined
  },
})

// Call below the test file's imports: an import-phase mock loses to the real @/lib/logger.
export function mockLoggerModule(overrides: Record<string, unknown> = {}) {
  mock.module('@/lib/logger', () => ({
    logger: noopLogger,
    createLogger: () => noopLogger,
    PerformanceTimer: class { start() {} stop() { return 0 } },
    ...overrides,
  }))
  return noopLogger
}
