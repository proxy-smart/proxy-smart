// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared ESLint React configuration for all frontend apps.
 *
 * Usage:
 *   import { reactConfig } from '../../eslint-config/react.js'
 *   // or from deeper: '../../../eslint-config/react.js'
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defaultIgnores, sharedRules } from './base.js'

/**
 * React app config with hooks + refresh plugins.
 * @param {object} options
 * @param {string} options.tsconfigRootDir - __dirname of the consuming config
 * @param {string[]} [options.files] - source globs (default: ['src/**\/*.{ts,tsx}'])
 * @param {string[]} [options.ignores] - additional ignores
 */
export function reactConfig({ tsconfigRootDir, files, ignores = [] }) {
  return [
    { ignores: [...defaultIgnores, '**/lib/api-client/**', ...ignores] },
    {
      files: files ?? ['src/**/*.{ts,tsx}'],
      extends: [js.configs.recommended, tseslint.configs.recommended],
      plugins: {
        'react-hooks': reactHooks,
        'react-refresh': reactRefresh,
      },
      rules: {
        ...sharedRules,
        ...reactHooks.configs.recommended.rules,
        'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
        'react-refresh/only-export-components': [
          'warn',
          { allowConstantExport: true },
        ],
      },
      languageOptions: {
        ecmaVersion: 2022,
        globals: globals.browser,
        parserOptions: {
          tsconfigRootDir,
          project: './tsconfig.app.json',
        },
      },
    },
    {
      files: ['vite.config.ts'],
      extends: [js.configs.recommended, tseslint.configs.recommended],
      languageOptions: {
        ecmaVersion: 2022,
        globals: globals.node,
        parserOptions: {
          tsconfigRootDir,
          project: './tsconfig.node.json',
        },
      },
    },
  ]
}
