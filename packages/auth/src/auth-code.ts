// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { createHash } from 'node:crypto'

/** The digest a launch session keeps of the authorization code it forwarded; never the code itself. */
export function hashAuthCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}
