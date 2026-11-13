// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createNodeConfig } from '@max-health-inc/config/eslint/node'
import { createReactConfig } from '@max-health-inc/config/eslint/react'

const REPO_IGNORES = ['**/.doccheck/**']

const withRepoIgnores = (options) => ({ ...options, ignores: [...REPO_IGNORES, ...(options.ignores ?? [])] })

export const nodePackageConfig = (options) => createNodeConfig(withRepoIgnores(options))

export const reactPackageConfig = (options) => createReactConfig(withRepoIgnores(options))
