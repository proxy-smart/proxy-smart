// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createHash } from 'node:crypto'

export function sha256(value: string, encoding: 'hex' | 'base64url' = 'hex'): string {
  return createHash('sha256').update(value, 'utf8').digest(encoding)
}
