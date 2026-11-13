// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { nodePackageConfig } from '../eslint.shared.js'

export default [
  ...nodePackageConfig({
    tsconfigRootDir: import.meta.dirname,
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/lib/api-client/**', 'public/**'],
    tests: true,
    testTsconfig: './tsconfig.json',
    testRunner: 'bun',
  }),
  { files: ['scripts/**/*.ts', 'src/export-openapi.ts', 'src/lib/logger.ts'], rules: { 'no-console': 'off' } },
  { files: ['src/**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-non-null-assertion': 'error' } },
]
