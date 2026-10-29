// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs'

/** File-backed persistence root; mount a named volume here in Docker. */
export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

/** Lives here, not in rag-tools: module-relative paths hit the filesystem root in the bundle, and rag-tools is mocked in tests. */
export function ragCachePath(): string {
  return join(DATA_DIR, 'rag-cache.json')
}

const SOURCE_BACKEND_ROOT = join(import.meta.dir, '..', '..')

/** Resolve the markdown docs dir with fallback chain for local dev, monorepo Docker, and standalone Docker. */
export function docsSourceDir(): string {
  if (process.env.RAG_DOCS_DIR) return process.env.RAG_DOCS_DIR
  const candidates = [
    join(SOURCE_BACKEND_ROOT, '..', 'docs'),
    join(process.cwd(), '..', 'docs'),
    join(process.cwd(), 'docs'),
    join(SOURCE_BACKEND_ROOT, 'docs'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/** Directory containing seed files baked into the Docker image */
const SEED_DIR = join(process.cwd(), 'data-seed')

/** Local dev fallback: deploy/dev/ at the repo root (when data-seed/ doesn't exist) */
const DEV_SEED_DIR = join(process.cwd(), '..', 'deploy', 'dev')

/** Ensure the data directory exists and seed missing config files from the image. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true })

  const seedDir = existsSync(SEED_DIR) ? SEED_DIR : existsSync(DEV_SEED_DIR) ? DEV_SEED_DIR : null

  if (seedDir) {
    for (const file of readdirSync(seedDir)) {
      const target = join(DATA_DIR, file)
      if (!existsSync(target)) {
        copyFileSync(join(seedDir, file), target)
      }
    }
  }
}

// On import: module-level singletons (e.g. AppStoreConfigStore) read DATA_DIR before index.ts runs.
ensureDataDir()
