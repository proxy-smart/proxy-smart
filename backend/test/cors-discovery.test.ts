// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { createApp } from '../src/app-factory'

const app = createApp()

function preflight(path: string, origin: string, method = 'GET', headers = 'Authorization'): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers },
  }))
}

describe('CORS on the proxy', () => {
  it('lets any origin read the Brand Bundle, sending If-None-Match as the spec advises', async () => {
    const res = await preflight('/branding.json', 'https://unknown-app.example', 'GET', 'If-None-Match')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://unknown-app.example')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('if-none-match')
  })

  it('lets any origin read SMART discovery', async () => {
    const res = await preflight('/proxy-smart-backend/hapi/R4/.well-known/smart-configuration', 'https://unknown-app.example')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://unknown-app.example')
  })

  it('does not open the token endpoint to an unregistered origin, nor to a look-alike of an allowed one', async () => {
    for (const origin of ['https://unknown-app.example', 'http://localhost:5173.evil.example']) {
      const res = await preflight('/auth/token', origin, 'POST')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})
