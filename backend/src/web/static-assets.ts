// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip, constants as zlib } from 'node:zlib'
import type { BunFile } from 'bun'
import { Elysia, NotFoundError } from 'elysia'
import { staticPlugin } from '@elysia/static'
import { mergeVary } from '../lib/http-caching'

export const PUBLIC_ROOT = 'public'
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const REVALIDATE_CACHE_CONTROL = 'no-cache'

const ASSETS_DIR = 'assets'
const MOUNT_SEARCH_DEPTH = 3
const MIN_COMPRESSIBLE_BYTES = 1024
export const MAX_COMPRESSIBLE_BYTES = 8 * 1024 * 1024
const COMPRESSIBLE_TYPE = /^text\/|javascript|json|xml|svg|wasm/
const CODINGS = ['br', 'gzip'] as const
/** On-the-fly levels: max-quality brotli costs seconds of CPU per MB and starved a small host. */
const BROTLI_QUALITY = 5
const GZIP_LEVEL = 6
const MAX_CONCURRENT_ENCODINGS = 2
const MAX_CACHED_BYTES = 64 * 1024 * 1024

export type ContentCoding = (typeof CODINGS)[number]

const compressBrotli = promisify(brotliCompress)
const compressGzip = promisify(gzip)
const encoded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
const encodedSizes = new Map<string, number>()
let cachedBytes = 0
let running = 0
const waiting: (() => void)[] = []

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
  return file.size >= MIN_COMPRESSIBLE_BYTES && file.size <= MAX_COMPRESSIBLE_BYTES && COMPRESSIBLE_TYPE.test(file.type)
}

async function withEncodingSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_ENCODINGS) await new Promise<void>(resolve => waiting.push(resolve))
  running += 1
  try {
    return await job()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

async function encode(file: BunFile, coding: ContentCoding): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Buffer.from(await file.arrayBuffer())
  const compressed = coding === 'gzip'
    ? await compressGzip(bytes, { level: GZIP_LEVEL })
    : await compressBrotli(bytes, {
      params: {
        [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
        [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    })
  return new Uint8Array(compressed)
}

function remember(key: string, size: number): void {
  encodedSizes.set(key, size)
  cachedBytes += size
  for (const [oldest, oldestSize] of encodedSizes) {
    if (cachedBytes <= MAX_CACHED_BYTES || oldest === key) break
    encodedSizes.delete(oldest)
    encoded.delete(oldest)
    cachedBytes -= oldestSize
  }
}

/** Content-hashed files never change under one name; codings are cached up to a byte budget. */
function encodedBody(path: string, file: BunFile, coding: ContentCoding): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${coding}:${path}`
  let body = encoded.get(key)
  if (!body) {
    body = withEncodingSlot(() => encode(file, coding))
    body.then(bytes => remember(key, bytes.byteLength), () => encoded.delete(key))
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

const DOTFILE_PATTERN = /[\\/]\.(?:DS_Store|git|env)(?:$|[\\/])/
/** Optional: only a deployment that mounts SMART app builds has it. The /apps/:app routes serve them. */
const APPS_DIR = 'apps'

/** The plugin matches ignore patterns against the path relative to its assets root. */
function topLevelDir(dir: string): RegExp {
  const sep = String.raw`[\\/]`
  return new RegExp(`^${sep}${escapeRegExp(dir)}${sep}`, 'i')
}

/** Plain public files (icons, fonts, robots.txt), one exact route each; hashed mounts go to {@link hashedAssetRoutes}. */
export function publicStaticPlugin(assetMounts: readonly string[], root = PUBLIC_ROOT) {
  return staticPlugin({
    assets: root,
    prefix: '/',
    alwaysStatic: true,
    indexHTML: false,
    ignorePatterns: [DOTFILE_PATTERN, topLevelDir(APPS_DIR), assetMountPattern(assetMounts)],
  })
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
