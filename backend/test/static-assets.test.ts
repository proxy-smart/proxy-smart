// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import {
  IMMUTABLE_CACHE_CONTROL,
  assetMountPattern,
  findAssetMounts,
  hashedAssetRoutes,
  negotiateEncoding,
  serveHashedAsset,
  serveSpaIndex,
  warmHashedAssets,
} from '../src/web/static-assets'
import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'

let root = ''
const script = `export const answer = ${JSON.stringify('x'.repeat(4096))}\n`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'static-assets-'))
  mkdirSync(join(root, 'webapp', 'assets'), { recursive: true })
  mkdirSync(join(root, 'apps', 'viewer', 'assets'), { recursive: true })
  mkdirSync(join(root, 'css'))
  writeFileSync(join(root, 'webapp', 'index.html'), '<!doctype html><title>ui</title>')
  writeFileSync(join(root, 'webapp', 'assets', 'index-abc123.js'), script)
  writeFileSync(join(root, 'webapp', 'assets', 'tiny-abc123.css'), 'a{}')
  writeFileSync(join(root, 'webapp', 'assets', 'font-abc123.woff2'), Buffer.alloc(4096, 7))
  writeFileSync(join(root, 'apps', 'viewer', 'assets', 'main-def456.js'), script)
  writeFileSync(join(root, 'secret.txt'), 'nope')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('negotiateEncoding', () => {
  it('prefers brotli over gzip when the client takes both', () => {
    expect(negotiateEncoding('gzip, deflate, br, zstd')).toBe('br')
  })

  it('falls back to gzip, and to identity when nothing usable is offered', () => {
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip')
    expect(negotiateEncoding('deflate')).toBeNull()
    expect(negotiateEncoding(null)).toBeNull()
  })

  it('honours q-values, including an explicit refusal', () => {
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip')
    expect(negotiateEncoding('br;q=0.2, gzip;q=0.8')).toBe('gzip')
    expect(negotiateEncoding('*')).toBe('br')
    expect(negotiateEncoding('*, br;q=0')).toBe('gzip')
  })
})

describe('asset mounts', () => {
  it('finds every assets directory a bundler emitted, nested apps included', () => {
    expect(findAssetMounts(root).sort()).toEqual(['apps/viewer/assets', 'webapp/assets'])
  })

  it('matches files inside a mount on either path separator, and nothing else', () => {
    const pattern = assetMountPattern(['webapp/assets'])
    expect(pattern.test('/srv/public/webapp/assets/index-abc123.js')).toBe(true)
    expect(pattern.test(String.raw`C:\srv\public\webapp\assets\index-abc123.js`)).toBe(true)
    expect(pattern.test('/srv/public/webapp/index.html')).toBe(false)
    expect(pattern.test('/srv/public/css/status.css')).toBe(false)
  })

  it('matches nothing when there are no mounts', () => {
    expect(assetMountPattern([]).test('/srv/public/webapp/assets/a.js')).toBe(false)
  })
})

describe('serveHashedAsset', () => {
  it('serves brotli with an immutable lifetime and a Vary on the coding', async () => {
    const res = await serveHashedAsset('webapp/assets', 'index-abc123.js', 'gzip, br', root)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-encoding')).toBe('br')
    expect(res?.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(res?.headers.get('vary')).toBe('Accept-Encoding')
    expect(res?.headers.get('content-type')).toContain('javascript')
    const body = Buffer.from(await res!.arrayBuffer())
    expect(body.length).toBeLessThan(script.length)
    expect(brotliDecompressSync(body).toString()).toBe(script)
  })

  it('serves gzip to a client without brotli', async () => {
    const res = await serveHashedAsset('apps/viewer/assets', 'main-def456.js', 'gzip', root)
    expect(res?.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res!.arrayBuffer())).toString()).toBe(script)
  })

  it('serves the bytes as they are to a client that takes no coding', async () => {
    const res = await serveHashedAsset('webapp/assets', 'index-abc123.js', null, root)
    expect(res?.headers.get('content-encoding')).toBeNull()
    expect(await res?.text()).toBe(script)
  })

  it('leaves already-compressed formats and tiny files uncoded', async () => {
    const font = await serveHashedAsset('webapp/assets', 'font-abc123.woff2', 'br', root)
    const css = await serveHashedAsset('webapp/assets', 'tiny-abc123.css', 'br', root)
    expect(font?.headers.get('content-encoding')).toBeNull()
    expect(css?.headers.get('content-encoding')).toBeNull()
    expect(css?.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
  })

  it('refuses traversal and missing files', async () => {
    expect(await serveHashedAsset('webapp/assets', '../../secret.txt', 'br', root)).toBeNull()
    expect(await serveHashedAsset('webapp/assets', String.raw`..\..\secret.txt`, 'br', root)).toBeNull()
    expect(await serveHashedAsset('webapp/assets', 'missing.js', 'br', root)).toBeNull()
  })
})

describe('hashedAssetRoutes', () => {
  it('wins over an app catch-all and 404s a missing asset instead of serving the SPA', async () => {
    const app = new Elysia()
      .use(hashedAssetRoutes(['webapp/assets'], root))
      .get('/webapp/*', () => 'spa')
    const hit = await app.handle(new Request('http://localhost/webapp/assets/index-abc123.js', { headers: { 'accept-encoding': 'br' } }))
    expect(hit.headers.get('content-encoding')).toBe('br')
    expect(hit.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect((await app.handle(new Request('http://localhost/webapp/assets/gone.js'))).status).toBe(404)
    expect(await (await app.handle(new Request('http://localhost/webapp/settings'))).text()).toBe('spa')
  })

  it('keeps Origin in Vary when CORS reflects the caller, so a shared cache cannot cross origins', async () => {
    const app = new Elysia()
      .use(cors({ origin: () => true, credentials: true }))
      .use(hashedAssetRoutes(['webapp/assets'], root))
    const res = await app.handle(new Request('http://localhost/webapp/assets/index-abc123.js', {
      headers: { 'accept-encoding': 'br', origin: 'https://a.example' },
    }))
    expect(res.headers.get('access-control-allow-origin')).toBe('https://a.example')
    const vary = (res.headers.get('vary') ?? '').split(',').map(v => v.trim().toLowerCase())
    expect(vary).toContain('origin')
    expect(vary).toContain('accept-encoding')
  })
})

describe('warmHashedAssets', () => {
  it('precomputes both codings of every compressible asset and skips the rest', async () => {
    expect(await warmHashedAssets(['webapp/assets', 'apps/viewer/assets', 'missing/assets'], root)).toBe(4)
  })
})

describe('serveSpaIndex', () => {
  it('makes the browser revalidate the entry document so a deploy is picked up at once', async () => {
    const res = await serveSpaIndex('webapp', root)
    expect(res?.headers.get('cache-control')).toBe('no-cache')
    expect(res?.headers.get('content-type')).toContain('text/html')
    expect(await res?.text()).toContain('<title>ui</title>')
  })

  it('answers null when the bundle is absent', async () => {
    expect(await serveSpaIndex('patient-picker', root)).toBeNull()
  })
})
