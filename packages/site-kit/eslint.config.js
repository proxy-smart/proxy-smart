// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { nodePackageConfig } from '../../eslint.shared.js'

export default nodePackageConfig({
  tsconfigRootDir: import.meta.dirname,
  files: ['**/*.{ts,tsx}'],
  extraRules: { '@typescript-eslint/triple-slash-reference': ['error', { path: 'always' }] },
})
