// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

// SMART App State (smart-app-state-basic profile) and the FHIR documents its endpoint returns.

export const STATE_CODE_PATTERN = '^[^|\\s]+\\|[^|]+$'

export const AppStateCode = t.String({
  pattern: STATE_CODE_PATTERN,
  description: 'An App State code as `system|code`, matching Basic.code.coding[0]',
})

const AppStateCoding = t.Object({
  system: t.String({ minLength: 1, description: 'App-specified code system, typically the app\'s origin' }),
  code: t.String({ minLength: 1, description: 'App-specified state type' }),
}, { additionalProperties: true })

const AppStateExtension = t.Object({
  id: t.Optional(t.String()),
  url: t.String({ minLength: 1 }),
  valueString: t.String({ description: 'App-managed state, stored and returned unmodified' }),
}, { additionalProperties: false, description: 'Top-level extension; only valueString is allowed and nested extensions are not' })

export const AppStateBasic = t.Object({
  resourceType: t.Literal('Basic'),
  id: t.Optional(t.String()),
  meta: t.Optional(t.Object({
    versionId: t.Optional(t.String()),
    lastUpdated: t.Optional(t.String()),
  }, { additionalProperties: true })),
  code: t.Object({
    coding: t.Array(AppStateCoding, { minItems: 1, maxItems: 1, description: 'Exactly one app-specified Coding' }),
  }, { additionalProperties: true }),
  subject: t.Optional(t.Object({
    reference: t.String({ minLength: 1, description: 'Absolute reference to a Patient, Practitioner, PractitionerRole, RelatedPerson or Person' }),
  }, { additionalProperties: true })),
  extension: t.Optional(t.Array(AppStateExtension)),
}, { additionalProperties: true, title: 'AppStateBasic', description: 'Basic resource conforming to the SMART smart-app-state-basic profile' })

export type AppStateBasicType = Static<typeof AppStateBasic>

export const AppStateBundle = t.Object({
  resourceType: t.Literal('Bundle'),
  type: t.Literal('searchset'),
  total: t.Number(),
  link: t.Array(t.Object({ relation: t.String(), url: t.String() })),
  entry: t.Array(t.Object({
    fullUrl: t.String(),
    resource: AppStateBasic,
    search: t.Object({ mode: t.Literal('match') }),
  })),
}, { title: 'AppStateBundle' })

export type AppStateBundleType = Static<typeof AppStateBundle>

export const FhirOperationOutcome = t.Object({
  resourceType: t.Literal('OperationOutcome'),
  issue: t.Array(t.Object({
    severity: t.Union([t.Literal('fatal'), t.Literal('error'), t.Literal('warning'), t.Literal('information')]),
    code: t.String({ description: 'FHIR issue-type code' }),
    diagnostics: t.Optional(t.String()),
  })),
}, { title: 'FhirOperationOutcome' })

export type FhirOperationOutcomeType = Static<typeof FhirOperationOutcome>

export const AppStateIdParam = t.Object({
  id: t.String({ description: 'Server-assigned Basic.id' }),
})

export const AppStateCapabilityStatement = t.Object({
  resourceType: t.Literal('CapabilityStatement'),
}, { additionalProperties: true, title: 'AppStateCapabilityStatement' })
