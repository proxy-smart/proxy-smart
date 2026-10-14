// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createReactConfig } from '@max-health-inc/config/eslint/react'

export default createReactConfig({
  tsconfigRootDir: import.meta.dirname,
  ignores: ['**/.doccheck/**'],
})
