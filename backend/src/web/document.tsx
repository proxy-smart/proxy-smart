// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Child, FC } from 'hono/jsx'
import { maxhealth, THEME_CSS, toCss } from 'brandc'
import { config } from '@/config'
import { brandAccent } from '@/lib/brand-color'
import { getRuntimeBrandConfig } from '@/lib/runtime-config'
import { jsonLdText } from './render'

export type Stylesheet = 'base' | 'landing' | 'status' | 'app-store'

export interface DocumentProps {
  title: string
  description?: string
  stylesheets: readonly Stylesheet[]
  head?: Child
  bodyClass?: string
  children?: Child
}

export const THEME_STORAGE_KEY = 'proxy-smart-theme'

/** Runs before first paint so a stored choice never flashes the other theme; no choice means the OS decides. */
const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

const themeCache = new Map<string, string>()

/** The shipped brand, recompiled with the deployment's accent as --main (and its deprecated --maxhealth alias). */
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
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
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
