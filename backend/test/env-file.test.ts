// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { upsertEnvContent } from '../src/lib/env-file'

describe('upsertEnvContent', () => {
  it('updates keys in place and keeps every other line', () => {
    const before = '# keep me\nBASE_URL=https://a.example\nKEYCLOAK_REALM=old\nSHL_EXCHANGE_CLIENT_SECRET=s3cret\n'
    expect(upsertEnvContent(before, { KEYCLOAK_REALM: 'new' })).toBe(
      '# keep me\nBASE_URL=https://a.example\nKEYCLOAK_REALM=new\nSHL_EXCHANGE_CLIENT_SECRET=s3cret\n'
    )
  })

  it('appends keys the file does not have yet', () => {
    expect(upsertEnvContent('BASE_URL=x\n', { KEYCLOAK_BASE_URL: 'http://kc' })).toBe('BASE_URL=x\nKEYCLOAK_BASE_URL=http://kc\n')
    expect(upsertEnvContent('', { KEYCLOAK_REALM: 'r' })).toBe('KEYCLOAK_REALM=r\n')
  })

  it('keeps CRLF line endings and leaves a commented-out key alone', () => {
    expect(upsertEnvContent('# KEYCLOAK_REALM=x\r\nA=1\r\n', { KEYCLOAK_REALM: 'r' })).toBe('# KEYCLOAK_REALM=x\r\nA=1\r\nKEYCLOAK_REALM=r\r\n')
  })
})
