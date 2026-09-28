// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Tests persist runtime state under DATA_DIR; point it at a throwaway copy so a run never rewrites the tracked backend/data.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

if (!process.env.DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-smart-test-data-'))
  const seed = join(import.meta.dir, '..', 'data', 'mcp-endpoint.json')
  if (existsSync(seed)) copyFileSync(seed, join(dir, 'mcp-endpoint.json'))
  process.env.DATA_DIR = dir
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}
