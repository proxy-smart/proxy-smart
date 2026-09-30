// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared ESLint base configuration for all packages.
 * 
 * Usage in any package's eslint.config.js:
 *   import { baseConfig, nodeConfig } from '../../eslint-config/base.js'
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

/** Build output and generated files no package should lint. */
export const defaultIgnores = ['dist/**', 'node_modules/**', '**/.doccheck/**']

/** Core TypeScript rules shared by all packages */
export const sharedRules = {
  // ── Code quality ──────────────────────────────────────────────────
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],

  // ── Best practices ────────────────────────────────────────────────
  'eqeqeq': ['error', 'always'],
  'no-var': 'error',
  'prefer-const': 'error',
}

/**
 * Base config for Node.js / backend packages.
 * @param {object} options
 * @param {string} options.tsconfigRootDir - __dirname of the consuming config
 * @param {string[]} [options.files] - glob patterns (default: ['**\/*.{js,ts}'])
 * @param {string[]} [options.ignores] - additional ignores
 */
export function baseConfig({ tsconfigRootDir, files, ignores = [] }) {
  return [
    { ignores: [...defaultIgnores, ...ignores] },
    {
      files: files ?? ['**/*.{js,ts}'],
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      languageOptions: {
        ecmaVersion: 2022,
        globals: globals.node,
        parserOptions: { tsconfigRootDir },
      },
      rules: {
        ...sharedRules,
      },
    },
  ]
}

/**
 * Alias for baseConfig — explicit Node.js context.
 */
export const nodeConfig = baseConfig
