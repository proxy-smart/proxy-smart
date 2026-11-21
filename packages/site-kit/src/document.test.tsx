// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { SiteDocument, renderDocument, renderToString } from './document'
import { parseDeploymentStage, type DeploymentStage } from './stage'

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

describe('SiteDocument stage', () => {
  const page = (stage?: DeploymentStage) => renderDocument(
    <SiteDocument title="t" iconHref="/i.svg" themeCss="" stylesheets={[]} stage={stage}>
      <nav class="site-nav" />
    </SiteDocument>,
  )

  it('puts the test banner above the page content and names the stage in the head on beta', () => {
    const html = page('beta')
    expect(html).toContain('<meta name="deployment-stage" content="beta"/>')
    expect(html).toContain('role="status"')
    expect(html.indexOf('class="stage-banner"')).toBeLessThan(html.indexOf('class="site-nav"'))
  })

  it('renders neither on production or without a stage', () => {
    for (const html of [page('production'), page()]) {
      expect(html).not.toContain('stage-banner')
      expect(html).not.toContain('deployment-stage')
    }
  })
})

describe('parseDeploymentStage', () => {
  it('accepts a known stage in any case and treats anything else as production', () => {
    expect(parseDeploymentStage(' Beta ')).toBe('beta')
    expect(parseDeploymentStage('production')).toBe('production')
    expect(parseDeploymentStage(undefined)).toBe('production')
    expect(parseDeploymentStage('staging"><script>')).toBe('production')
  })
})

describe('renderToString', () => {
  it('rejects an async component instead of emitting [object Promise]', () => {
    const Async = async () => <p>later</p>
    expect(() => renderToString(<div><Async /></div>)).toThrow()
  })
})
