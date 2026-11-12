// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Child, FC } from 'hono/jsx'
import { maxhealth, THEME_CSS, toCss } from 'brandc'
import { SiteDocument, asset } from '@proxy-smart/site-kit'
import { config } from '@/config'
import { brandAccent } from '@/lib/brand-color'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { jsonLdText } from './render'

export type Stylesheet = 'base' | 'instance' | 'status' | 'app-store'

export interface DocumentProps {
  title: string
  description?: string
  stylesheets: readonly Stylesheet[]
  head?: Child
  bodyClass?: string
  children?: Child
}

const themeCache = new Map<string, string>()

function themeCss(): string {
  const accent = brandAccent(getRuntimeBrandConfig())
  if (!accent) return THEME_CSS
  const cached = themeCache.get(accent)
  if (cached) return cached
  const token = { light: accent, dark: accent }
  const css = toCss({ ...maxhealth, colors: { ...maxhealth.colors, main: token, maxhealth: token } })
  themeCache.set(accent, css)
  return css
}

export const Document: FC<DocumentProps> = ({ title, description, stylesheets, head, bodyClass, children }) => (
  <SiteDocument
    title={title}
    iconHref="/proxy-smart.svg"
    themeCss={themeCss()}
    stylesheets={stylesheets.map(sheet => asset(`/css/${sheet}.css`, config.version))}
    meta={description ? <meta name="description" content={description} /> : null}
    head={head}
    bodyClass={bodyClass}
  >
    {children}
  </SiteDocument>
)

export const JsonLd: FC<{ data: unknown }> = ({ data }) => (
  <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
)
