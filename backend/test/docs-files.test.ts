// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDocsFile, serveDocs } from '../src/lib/docs-files'

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'docs-files-'))
  mkdirSync(join(root, 'admin-ui'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), 'home')
  writeFileSync(join(root, 'fhir-proxy.html'), 'fhir proxy')
  writeFileSync(join(root, 'admin-ui', 'index.html'), 'admin index')
  writeFileSync(join(root, 'admin-ui', 'dashboard.html'), 'dashboard')
  writeFileSync(join(root, 'assets', 'app.js'), 'js')
  writeFileSync(join(root, '404.html'), 'not found page')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const body = async (path: string) => (await resolveDocsFile(path, root))?.text()

describe('docs clean URLs', () => {
  it('serves the page a clean URL names, not the docs home', async () => {
    expect(await body('fhir-proxy')).toBe('fhir proxy')
    expect(await body('admin-ui/dashboard')).toBe('dashboard')
  })

  it('serves a directory index with or without the trailing slash', async () => {
    expect(await body('')).toBe('home')
    expect(await body('admin-ui/')).toBe('admin index')
    expect(await body('admin-ui')).toBe('admin index')
  })

  it('serves assets as they are', async () => {
    expect(await body('assets/app.js')).toBe('js')
  })

  it('refuses traversal', async () => {
    expect(await resolveDocsFile('../secret', root)).toBeNull()
    expect(await resolveDocsFile(String.raw`admin-ui\..\secret`, root)).toBeNull()
  })

  it('answers a missing page with the 404 page and a 404 status', async () => {
    const res = await serveDocs('does-not-exist', root)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found page')
  })
})
