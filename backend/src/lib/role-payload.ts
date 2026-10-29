// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Shared realm/client role attributes; descriptive only, FHIR/MCP enforcement stays scope-based.
import type RoleRepresentation from '@keycloak/keycloak-admin-client/lib/defs/roleRepresentation.js'
import { REPRESENTED_SCOPE_SET_ATTR, FHIR_SCOPES_ATTR } from './role-metadata'

export interface RoleMetadataInput {
  description?: string
  fhirScopes?: string[]
  /** Empty string clears the link; undefined leaves it untouched on update. */
  representedScopeSetId?: string
}

const SMART_ROLE_ATTR = 'smart_role'

export function buildRoleAttributes(input: RoleMetadataInput): RoleRepresentation['attributes'] {
  return {
    [SMART_ROLE_ATTR]: ['true'],
    [FHIR_SCOPES_ATTR]: input.fhirScopes ?? [],
    ...(input.representedScopeSetId
      ? { [REPRESENTED_SCOPE_SET_ATTR]: [input.representedScopeSetId] }
      : {})
  }
}

export function mergeRoleUpdate(existing: RoleRepresentation, input: RoleMetadataInput): RoleRepresentation {
  const existingScopeSet = existing.attributes?.[REPRESENTED_SCOPE_SET_ATTR]

  let scopeSetAttr: Record<string, string[]>
  if (input.representedScopeSetId === undefined) {
    scopeSetAttr = existingScopeSet ? { [REPRESENTED_SCOPE_SET_ATTR]: existingScopeSet } : {}
  } else if (input.representedScopeSetId === '') {
    scopeSetAttr = {}
  } else {
    scopeSetAttr = { [REPRESENTED_SCOPE_SET_ATTR]: [input.representedScopeSetId] }
  }

  const { [REPRESENTED_SCOPE_SET_ATTR]: _replaced, ...attrsWithoutScopeSet } = existing.attributes ?? {}

  return {
    ...existing,
    description: input.description ?? existing.description,
    attributes: {
      ...attrsWithoutScopeSet,
      [FHIR_SCOPES_ATTR]: input.fhirScopes ?? existing.attributes?.[FHIR_SCOPES_ATTR] ?? [],
      ...scopeSetAttr
    }
  }
}
