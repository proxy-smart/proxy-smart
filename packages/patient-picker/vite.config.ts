// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createSmartViteConfig } from '../../config/vite-config.ts'

export default createSmartViteConfig(
  { base: '/patient-picker/', port: 5176 },
  import.meta.dirname,
)
