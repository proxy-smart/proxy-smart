// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createNodeConfig } from '@max-health-inc/config/eslint/node'

export default [
  ...createNodeConfig({
    tsconfigRootDir: import.meta.dirname,
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/lib/api-client/**', 'public/**', '**/.doccheck/**'],
    tests: true,
    testTsconfig: './tsconfig.json',
    testRunner: 'bun',
  }),
  // Command-line entry points and the logger's own sink write to the console by design.
  { files: ['scripts/**/*.ts', 'src/export-openapi.ts', 'src/lib/logger.ts'], rules: { 'no-console': 'off' } },
]
