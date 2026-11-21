// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { BunFile } from 'bun'
import { PUBLIC_ROOT } from './paths'

export const DOCS_ROOT = `${PUBLIC_ROOT}/docs`

export type HtmlDecorator = (html: string) => string

function candidates(path: string): string[] {
  if (path === '' || path.endsWith('/')) return [`${path}index.html`]
  if (/\.[a-z0-9]+$/i.test(path)) return [path]
  return [`${path}.html`, `${path}/index.html`]
}

export async function resolveDocsFile(path: string, root = DOCS_ROOT): Promise<BunFile | null> {
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) return null
  for (const candidate of candidates(path)) {
    const file = Bun.file(`${root}/${candidate}`)
    if (await file.exists()) return file
  }
  return null
}

async function docsBody(file: BunFile, decorateHtml?: HtmlDecorator): Promise<BunFile | string> {
  return decorateHtml && file.type.startsWith('text/html') ? decorateHtml(await file.text()) : file
}

export async function docsNotFound(root = DOCS_ROOT, decorateHtml?: HtmlDecorator): Promise<Response> {
  const page = Bun.file(`${root}/404.html`)
  if (await page.exists()) return new Response(await docsBody(page, decorateHtml), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  return Response.json({ error: 'Not Found' }, { status: 404 })
}

export async function serveDocs(path: string, root = DOCS_ROOT, decorateHtml?: HtmlDecorator): Promise<Response> {
  const file = await resolveDocsFile(path, root)
  if (!file) return docsNotFound(root, decorateHtml)
  const body = await docsBody(file, decorateHtml)
  return typeof body === 'string' ? new Response(body, { headers: { 'Content-Type': file.type } }) : new Response(body)
}
