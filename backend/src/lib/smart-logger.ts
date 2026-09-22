// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { SmartProxyLogger } from '@proxy-smart/auth'
import { logger } from './logger'

/** Adapts the backend's structured logger to the flat interface @proxy-smart/auth expects. */
export const smartLogger: SmartProxyLogger = {
  debug: (msg, meta) => logger.auth.debug(msg, meta),
  info: (msg, meta) => logger.auth.info(msg, meta),
  warn: (msg, meta) => logger.auth.warn(msg, meta),
  error: (msg, meta) => logger.auth.error(msg, meta),
}
