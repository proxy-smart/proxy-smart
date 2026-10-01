// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { defineConfig } from 'eslint/config'
import { baseConfig } from '../../config/eslint/base.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  ...baseConfig({
    tsconfigRootDir: __dirname,
  }),
  { rules: { '@typescript-eslint/triple-slash-reference': ['error', { path: 'always' }] } },
)
