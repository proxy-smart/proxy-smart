// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it } from 'bun:test'
import { AppIcon, Glyph, isAppIconKey } from './app-icons'

const html = (node: unknown) => String(node)

describe('Glyph', () => {
  it('draws a diagram glyph with the shared stroke style', () => {
    const svg = html(<Glyph name="database" class="pipe" />)
    expect(svg).toContain('<ellipse cx="12" cy="5.5"')
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toContain('class="pipe"')
  })

  it('draws the same glyph an app icon uses for the same name', () => {
    expect(html(<AppIcon icon="lock" />)).toContain(html(<Glyph name="lock" />))
  })
})

describe('AppIcon', () => {
  it('keeps the curated app set: diagram glyphs are not app icons', () => {
    expect(isAppIconKey('lock')).toBe(true)
    expect(isAppIconKey('filter')).toBe(false)
  })

  it('falls back to the app-window glyph for anything outside the app set', () => {
    expect(html(<AppIcon icon="filter" />)).toContain(html(<Glyph name="app-window" />))
  })
})
