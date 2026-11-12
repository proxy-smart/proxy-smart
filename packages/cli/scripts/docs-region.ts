// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { code, table } from '../../../backend/scripts/docs/regions'
import { DOMAIN_COMMANDS } from '../src/cli'
import { SETTINGS } from '../src/config'
import { helpText } from '../src/help'

const regions: Readonly<Record<string, () => string>> = {
  'cli-help': () => ['```text', helpText(DOMAIN_COMMANDS), '```'].join('\n'),
  'cli-settings': () => table(
    ['Setting', 'Flag', 'Env var', 'Default'],
    SETTINGS.map(setting => [
      setting.label,
      setting.flag ? code(setting.flag) : '—',
      code(setting.env),
      setting.fallback ? code(setting.fallback) : '(unset)',
    ]),
  ),
}

const kind = process.argv[2] ?? ''
const render = regions[kind]
if (!render) {
  process.stderr.write(`unknown CLI docs region "${kind}"; known: ${Object.keys(regions).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write(render())
