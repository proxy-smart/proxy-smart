// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t } from 'elysia'
import path from 'path'
import { promises as fs } from 'fs'
import { isErrnoException } from '@/lib/type-guards'
import type { MonitoringEndpointSpec } from './factory'

export interface JsonlExportConfig {
  path?: string
  /** Directory under logs/ */
  logDir: string
  logFile: string
  /** Filename stem; the date and .jsonl are appended */
  downloadPrefix: string
  summary: string
  description: string
  onError: (error: unknown) => void
}

/** JSONL download endpoint for a metrics logger; a missing log file downloads as empty. */
export function createJsonlExportSpec(cfg: JsonlExportConfig): MonitoringEndpointSpec {
  return {
    path: cfg.path ?? '/events/export',
    handler: async ({ set }) => {
      const filename = `${cfg.downloadPrefix}-${new Date().toISOString().split('T')[0]}.jsonl`
      set.headers['Content-Type'] = 'application/x-jsonlines'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      const logPath = path.join(process.cwd(), 'logs', cfg.logDir, cfg.logFile)
      try {
        return await fs.readFile(logPath, 'utf-8')
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return ''
        cfg.onError(error)
        set.status = 500
        throw new Error(`Failed to export ${cfg.downloadPrefix}`, { cause: error })
      }
    },
    response: t.String(),
    summary: cfg.summary,
    description: cfg.description,
  }
}
