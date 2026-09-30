// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { BunFile } from 'bun'

export const DOCS_ROOT = 'public/docs'

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

export async function docsNotFound(root = DOCS_ROOT): Promise<Response> {
  const page = Bun.file(`${root}/404.html`)
  if (await page.exists()) return new Response(page, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  return Response.json({ error: 'Not Found' }, { status: 404 })
}

export async function serveDocs(path: string, root = DOCS_ROOT): Promise<Response> {
  const file = await resolveDocsFile(path, root)
  return file ? new Response(file) : docsNotFound(root)
}
