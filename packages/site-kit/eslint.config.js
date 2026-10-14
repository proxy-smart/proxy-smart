// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createNodeConfig } from '@max-health-inc/config/eslint/node'

export default createNodeConfig({
  tsconfigRootDir: import.meta.dirname,
  files: ['**/*.{ts,tsx}'],
  ignores: ['**/.doccheck/**'],
  extraRules: { '@typescript-eslint/triple-slash-reference': ['error', { path: 'always' }] },
})
