// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Child, FC } from 'hono/jsx'
import type { JSX } from 'hono/jsx/jsx-runtime'
import { THEME_BOOT_SCRIPT } from './theme'

export interface SiteDocumentProps {
  title: string
  iconHref: string
  themeCss: string
  stylesheets: readonly string[]
  meta?: Child
  head?: Child
  bodyClass?: string
  children?: Child
}

export const SiteDocument: FC<SiteDocumentProps> = ({ title, iconHref, themeCss, stylesheets, meta, head, bodyClass, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      <link rel="icon" type="image/svg+xml" href={iconHref} />
      <title>{title}</title>
      {meta}
      <style dangerouslySetInnerHTML={{ __html: themeCss }} />
      {stylesheets.map(href => <link rel="stylesheet" href={href} />)}
      {head}
    </head>
    <body class={bodyClass}>{children}</body>
  </html>
)

export function renderToString(element: JSX.Element): string {
  if (element instanceof Promise) throw new Error('renderToString: async components are not supported')
  const html: unknown = element.toString()
  if (typeof html !== 'string') throw new Error('renderToString: async components are not supported')
  return html
}

export function renderDocument(element: JSX.Element): string {
  return `<!DOCTYPE html>${renderToString(element)}`
}
