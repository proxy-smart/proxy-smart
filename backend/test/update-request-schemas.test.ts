// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { KindGuard } from '@sinclair/typebox'
import * as schemas from '../src/schemas'

const updateRequests = Object.entries(schemas).flatMap(([name, value]) =>
  /^Update\w*Request$/.test(name) && KindGuard.IsSchema(value) ? [{ name, schema: value }] : [],
)

describe('update request bodies', () => {
  it('are found', () => {
    expect(updateRequests.map(({ name }) => name)).toEqual(expect.arrayContaining(['UpdateDicomServerRequest', 'UpdateFhirServerRequest']))
  })

  it.each(updateRequests)('$name fills in nothing the client did not send', ({ schema }) => {
    expect(Value.Default(schema, {})).toEqual({})
  })
})
