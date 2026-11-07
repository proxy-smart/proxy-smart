// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord, parseJsonRecord } from './type-guards'

export interface PublicIdentity {
  software: string
  description: string
}

/** Present the deployment, not the upstream product, in a served CapabilityStatement; other bodies pass through. */
export function withPublicIdentity(body: string, identity: PublicIdentity): string {
  const statement = parseJsonRecord(body)
  if (statement?.resourceType !== 'CapabilityStatement') return body

  const { name: _name, text: _text, ...rest } = statement
  const implementation = isRecord(statement.implementation) ? statement.implementation : {}
  return JSON.stringify({
    ...rest,
    software: { name: identity.software },
    implementation: { ...implementation, description: identity.description },
  })
}
