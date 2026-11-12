// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { SiteDocument, renderDocument, renderToString } from './document'

describe('SiteDocument', () => {
  const html = renderDocument(
    <SiteDocument
      title="Status"
      iconHref="/icon.svg"
      themeCss=":root{--x:1}"
      stylesheets={['/css/a.css', '/css/b.css']}
      meta={<meta name="description" content="d" />}
      head={<link rel="preload" href="/f.woff2" />}
      bodyClass="page"
    >
      <main>body</main>
    </SiteDocument>,
  )

  it('starts with a doctype', () => {
    expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
  })

  it('places meta after the title and extra head content after the stylesheets', () => {
    const order = ['<title>Status</title>', 'name="description"', ':root{--x:1}', '/css/a.css', '/css/b.css', '/f.woff2']
    const positions = order.map(part => html.indexOf(part))
    expect(positions.every(position => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('applies the body class', () => {
    expect(html).toContain('<body class="page"><main>body</main></body>')
  })
})

describe('renderToString', () => {
  it('rejects an async component instead of emitting [object Promise]', () => {
    const Async = async () => <p>later</p>
    expect(() => renderToString(<div><Async /></div>)).toThrow()
  })
})
