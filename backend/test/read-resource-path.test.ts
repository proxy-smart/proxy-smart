// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { matchResource } from '../src/lib/ai/read-resource-tool'

const RESOURCES = new Map([
  ['/admin/smart-apps/', 'list'],
  ['/admin/smart-apps/:clientId', 'one'],
])

describe('read_resource path matching', () => {
  it('hands the executor a decoded value, since it encodes path params itself', () => {
    const match = matchResource('/admin/smart-apps/https%3A%2F%2Fclaude.ai%2Foauth%2Fmcp-oauth-client-metadata', RESOURCES)
    expect(match).toEqual({ meta: 'one', pathParams: { clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata' } })
  })

  it('keeps a plain or malformed segment as written', () => {
    expect(matchResource('/admin/smart-apps/smart_app_1', RESOURCES)?.pathParams).toEqual({ clientId: 'smart_app_1' })
    expect(matchResource('/admin/smart-apps/100%', RESOURCES)?.pathParams).toEqual({ clientId: '100%' })
  })

  it('matches a literal path exactly', () => {
    expect(matchResource('/admin/smart-apps/', RESOURCES)?.meta).toBe('list')
  })
})
