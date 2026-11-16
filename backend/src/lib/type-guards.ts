// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Value } from '@sinclair/typebox/value'
import type { Static, TSchema } from '@sinclair/typebox'
import { isRecord } from '@proxy-smart/guards'

export {
  isRecord,
  requireRecord,
  stringArray,
  stringList,
  optionalString,
  optionalNumber,
  isStringArray,
  isOneOf,
  isHttpUrl,
  stringEntries,
  parseJson,
  parseJsonRecord,
} from '@proxy-smart/guards'

/** A type guard that holds exactly when `value` matches the TypeBox `schema`. */
export function matchesSchema<S extends TSchema>(schema: S): (value: unknown) => value is Static<S> {
  return (value: unknown): value is Static<S> => Value.Check(schema, value)
}

/** A Node or Bun system error carrying its errno `code`, such as ECONNREFUSED or Bun's ConnectionRefused. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

/** The HTTP status an error carries on `response.status`, as Keycloak admin-client errors do. */
export function errorResponseStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined
  const status = error.response.status
  return typeof status === 'number' ? status : undefined
}
