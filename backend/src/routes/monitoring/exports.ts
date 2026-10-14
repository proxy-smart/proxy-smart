// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Monitoring log exports.
 *
 * Each metrics logger mirrors its events to a JSONL file under logs/, and each
 * monitoring module offers that file as a download. The path and the filename
 * differ; the read, the fallback and the attachment headers do not.
 */

import { t } from 'elysia'
import path from 'path'
import { promises as fs } from 'fs'
import { isRecord } from '@/lib/type-guards'
import type { MonitoringEndpointSpec } from './factory'

export interface JsonlExportConfig {
  /** Path within the module prefix; defaults to '/events/export' */
  path?: string
  /** Directory under logs/, e.g. 'oauth-metrics' */
  logDir: string
  /** File within that directory, e.g. 'oauth-events.jsonl' */
  logFile: string
  /** Download filename stem; the date and .jsonl are appended */
  downloadPrefix: string
  summary: string
  description: string
  /** Reported when the read fails for a reason other than the file being absent */
  onError: (error: unknown) => void
}

/**
 * Build the JSONL download endpoint for a metrics logger.
 *
 * A missing log file is not an error — a deployment that has not logged an event
 * yet should download an empty file rather than a 500.
 */
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
        if (isRecord(error) && error.code === 'ENOENT') return ''
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
