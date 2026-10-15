// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip, constants as zlib } from 'node:zlib'
import type { BunFile } from 'bun'
import { Elysia, NotFoundError } from 'elysia'
import { mergeVary } from '../lib/http-caching'

export const PUBLIC_ROOT = 'public'
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const REVALIDATE_CACHE_CONTROL = 'no-cache'

const ASSETS_DIR = 'assets'
const MOUNT_SEARCH_DEPTH = 3
const MIN_COMPRESSIBLE_BYTES = 1024
const COMPRESSIBLE_TYPE = /^text\/|javascript|json|xml|svg|wasm/
const CODINGS = ['br', 'gzip'] as const

export type ContentCoding = (typeof CODINGS)[number]

const compressBrotli = promisify(brotliCompress)
const compressGzip = promisify(gzip)
const encoded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

function codingQualities(acceptEncoding: string): Map<string, number> {
  const qualities = new Map<string, number>()
  for (const part of acceptEncoding.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';')
    if (!token) continue
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='))
    qualities.set(token, q ? Number(q.slice(2)) || 0 : 1)
  }
  return qualities
}

/** The best coding the client accepts, br over gzip on a tie (RFC 9110 §12.5.3). */
export function negotiateEncoding(acceptEncoding: string | null | undefined): ContentCoding | null {
  if (!acceptEncoding) return null
  const qualities = codingQualities(acceptEncoding)
  const wildcard = qualities.get('*') ?? 0
  let best: ContentCoding | null = null
  let bestQ = 0
  for (const coding of CODINGS) {
    const q = qualities.get(coding) ?? wildcard
    if (q > bestQ) {
      best = coding
      bestQ = q
    }
  }
  return best
}

/** Bundler output directories (`<app>/assets`) under the public root, as root-relative paths. */
export function findAssetMounts(root = PUBLIC_ROOT, depth = MOUNT_SEARCH_DEPTH, prefix = ''): string[] {
  if (depth === 0) return []
  let entries
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.name === ASSETS_DIR) return prefix ? [path] : []
      return findAssetMounts(root, depth - 1, path)
    })
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches absolute file paths inside any of the mounts, on either path separator. */
export function assetMountPattern(mounts: readonly string[]): RegExp {
  if (mounts.length === 0) return /(?!)/
  const sep = String.raw`[\\/]`
  const alternatives = mounts.map(mount => mount.split('/').map(escapeRegExp).join(sep))
  return new RegExp(`${sep}(?:${alternatives.join('|')})${sep}`)
}

function isSafeRelativePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}

function isCompressible(file: BunFile): boolean {
  return file.size >= MIN_COMPRESSIBLE_BYTES && COMPRESSIBLE_TYPE.test(file.type)
}

async function encode(file: BunFile, coding: ContentCoding): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Buffer.from(await file.arrayBuffer())
  const compressed = coding === 'gzip'
    ? await compressGzip(bytes, { level: zlib.Z_BEST_COMPRESSION })
    : await compressBrotli(bytes, {
      params: {
        [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
        [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
        [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    })
  return new Uint8Array(compressed)
}

/** Content-hashed files never change under one name, so each coding is computed once per process. */
function encodedBody(path: string, file: BunFile, coding: ContentCoding): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${coding}:${path}`
  let body = encoded.get(key)
  if (!body) {
    body = encode(file, coding)
    body.catch(() => encoded.delete(key))
    encoded.set(key, body)
  }
  return body
}

/**
 * A file from a bundler's content-hashed output: cacheable for a year, and
 * compressed here so a deployment without a compressing proxy still sends it small.
 */
export async function serveHashedAsset(
  mount: string,
  path: string,
  acceptEncoding: string | null | undefined,
  root = PUBLIC_ROOT,
): Promise<Response | null> {
  if (!isSafeRelativePath(path)) return null
  const location = `${root}/${mount}/${path}`
  const file = Bun.file(location)
  if (!(await file.exists())) return null

  const headers: Record<string, string> = {
    'Content-Type': file.type,
    'Cache-Control': IMMUTABLE_CACHE_CONTROL,
    Vary: 'Accept-Encoding',
  }
  const coding = isCompressible(file) ? negotiateEncoding(acceptEncoding) : null
  if (!coding) return new Response(file, { headers })

  const body = await encodedBody(location, file, coding)
  return new Response(body, { headers: { ...headers, 'Content-Encoding': coding } })
}

/** Precompute every coding of every mounted asset, so no visitor waits on max-quality brotli. */
export async function warmHashedAssets(mounts: readonly string[], root = PUBLIC_ROOT): Promise<number> {
  const jobs = mounts.flatMap(mount => {
    let names: string[]
    try {
      names = readdirSync(join(root, mount), { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
    } catch {
      return []
    }
    return names.flatMap(name => {
      const location = `${root}/${mount}/${name}`
      const file = Bun.file(location)
      return isCompressible(file) ? CODINGS.map(coding => encodedBody(location, file, coding)) : []
    })
  })
  await Promise.all(jobs)
  return jobs.length
}

/** One wildcard route per mount, hidden from the API spec. */
export function hashedAssetRoutes(mounts: readonly string[], root = PUBLIC_ROOT) {
  const plugin = new Elysia({ name: 'hashed-assets', seed: mounts.join(',') })
  for (const mount of mounts) {
    plugin.get(`/${mount}/*`, async ({ params, headers, set }) => {
      const response = await serveHashedAsset(mount, params['*'], headers['accept-encoding'], root)
      if (!response) throw new NotFoundError()
      const upstreamVary = set.headers.vary
      if (typeof upstreamVary === 'string') response.headers.set('Vary', mergeVary(upstreamVary, response.headers.get('Vary')))
      return response
    }, { detail: { hide: true } })
  }
  return plugin
}

/** A single-page app's entry document, revalidated on every load since it names the current hashes. */
export async function serveSpaIndex(app: string, root = PUBLIC_ROOT): Promise<Response | null> {
  const index = Bun.file(`${root}/${app}/index.html`)
  if (!(await index.exists())) return null
  return new Response(index, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': REVALIDATE_CACHE_CONTROL },
  })
}
