// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Where an SHL recipient lands. Beta serves the portal under the proxy's path; production serves
 * it at the root of its own host, which used to be discarded as "root-only".
 */
import { describe, it, expect } from 'bun:test'

process.env.BASE_URL = 'https://api.proxy-smart.com'
const { resolveShlViewerBase } = await import('../src/lib/client-launch-url')

describe('resolveShlViewerBase', () => {
  it('keeps an app served at the root of its own host', () => {
    expect(resolveShlViewerBase('https://patient.maxhealth.tech/', null)).toBe('https://patient.maxhealth.tech/')
  })

  it("keeps an app's path on the proxy host", () => {
    expect(resolveShlViewerBase('https://api.proxy-smart.com/apps/patient-portal/', null))
      .toBe('https://api.proxy-smart.com/apps/patient-portal/')
  })

  it("refuses the proxy's own root, which is the proxy homepage", () => {
    expect(resolveShlViewerBase('https://api.proxy-smart.com/', 'https://patient.maxhealth.tech/'))
      .toBe('https://patient.maxhealth.tech/')
  })

  it('uses the configured portal when the app has no launch URL', () => {
    expect(resolveShlViewerBase(null, 'https://patient.maxhealth.tech/')).toBe('https://patient.maxhealth.tech/')
  })

  it('falls back to the proxy-hosted portal when nothing is configured', () => {
    expect(resolveShlViewerBase(undefined, null)).toBe('https://api.proxy-smart.com/apps/patient-portal/')
    expect(resolveShlViewerBase('not a url', null)).toBe('https://api.proxy-smart.com/apps/patient-portal/')
  })
})
