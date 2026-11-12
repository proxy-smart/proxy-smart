// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { join } from 'path'

const CLI_REGIONS = join('packages', 'cli', 'scripts', 'docs-region.ts')

export function cliRegion(root: string, kind: string): string {
  const result = Bun.spawnSync([process.execPath, CLI_REGIONS, kind], { cwd: root })
  if (result.exitCode !== 0) throw new Error(`${CLI_REGIONS} ${kind} exited ${result.exitCode}: ${result.stderr.toString()}`)
  return result.stdout.toString().replace(/\r\n/g, '\n')
}
