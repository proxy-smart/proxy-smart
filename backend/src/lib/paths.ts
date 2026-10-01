// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs'

/**
 * Centralized data directory for all file-backed persistence.
 * In Docker, mount a named volume at this path for durability across redeploys.
 * Override with DATA_DIR env var if needed.
 */
export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

/**
 * Where the RAG embedding cache is written.
 *
 * Path policy belongs HERE, not in the module that happens to use it. `rag-tools.ts` previously
 * built its own with `join(BACKEND_ROOT, 'logs', 'rag-cache.json')`, where BACKEND_ROOT was three
 * levels up from the module file — `backend/` in the source tree, but the FILESYSTEM ROOT in the
 * deployed bundle, whose layout differs. So `search_documentation` died with
 * `EACCES: permission denied, mkdir '/logs'` (observed 2026-08-01 through the live claude.ai
 * connector), and a stray `logs/` appeared in developers' repo roots whenever the module was
 * touched from an unexpected working directory.
 *
 * Living here also keeps it out of reach of `mock.module('../src/lib/ai/rag-tools')`, which
 * replaces that whole module in the MCP endpoint tests — an export added there is invisible to
 * any suite loaded after the mock.
 */
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

  // Determine seed source: Docker image has data-seed/, local dev uses deploy/dev/
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

// Run immediately on import so seed files are in place before any store constructors fire.
// This is critical because module-level singletons (e.g. AppStoreConfigStore) read from
// DATA_DIR during import-time construction, which happens before index.ts body executes.
ensureDataDir()
