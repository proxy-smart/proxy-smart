// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { Value } from '@sinclair/typebox/value'
import { FhirPersonAssociation } from '@/schemas/admin/users'
import { parseJson } from './type-guards'

export type FhirPersonAssociationType = Static<typeof FhirPersonAssociation>

const FhirPersonAssociations = t.Array(FhirPersonAssociation)

/** The `fhir_persons` user attribute: which Person a user is on which FHIR server. Malformed values read as none. */
export function parseFhirPersons(raw: string | undefined): FhirPersonAssociationType[] {
  const parsed = parseJson(raw)
  return Value.Check(FhirPersonAssociations, parsed) ? parsed : []
}
