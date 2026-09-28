// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Child, FC } from 'hono/jsx'
import { THEME_CSS } from 'brandc'
import { config } from '@/config'
import { brandAccent } from '@/lib/brand-color'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { jsonLdText } from './render'

export type Stylesheet = 'base' | 'landing' | 'status'

export interface DocumentProps {
  title: string
  description?: string
  stylesheets: readonly Stylesheet[]
  head?: Child
  bodyClass?: string
  children?: Child
}

function themeCss(): string {
  const accent = brandAccent(getRuntimeBrandConfig())
  return accent ? `${THEME_CSS}\n:root{--brand-accent:${accent}}` : THEME_CSS
}

export const Document: FC<DocumentProps> = ({ title, description, stylesheets, head, bodyClass, children }) => (
  <html lang="en" class="dark">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#000000" />
      <link rel="icon" type="image/svg+xml" href="/proxy-smart.svg" />
      <title>{title}</title>
      {description ? <meta name="description" content={description} /> : null}
      <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      {stylesheets.map(sheet => (
        <link rel="stylesheet" href={`/css/${sheet}.css?v=${encodeURIComponent(config.version)}`} />
      ))}
      {head}
    </head>
    <body class={bodyClass}>{children}</body>
  </html>
)

export const JsonLd: FC<{ data: unknown }> = ({ data }) => (
  <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
)
