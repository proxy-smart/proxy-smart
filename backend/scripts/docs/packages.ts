// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readFileSync } from 'fs'
import { join } from 'path'
import { Type } from '@sinclair/typebox'
import { matchesSchema } from '../../src/lib/type-guards'
import { cell, code, table } from './regions'

const RootManifest = Type.Object({
  repository: Type.Object({ url: Type.String() }),
  workspaces: Type.Array(Type.String()),
})

const PackageManifest = Type.Object({
  name: Type.String(),
  description: Type.String(),
  private: Type.Optional(Type.Boolean()),
  versionPolicy: Type.Optional(Type.String()),
})

const isRootManifest = matchesSchema(RootManifest)
const isPackageManifest = matchesSchema(PackageManifest)

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function packagesTable(root: string): string {
  const manifest = readJson(join(root, 'package.json'))
  if (!isRootManifest(manifest)) throw new Error('package.json has no repository.url or workspaces')
  const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  const published = manifest.workspaces.filter(dir => dir.startsWith('packages/')).sort().flatMap(dir => {
    const pkg = readJson(join(root, dir, 'package.json'))
    if (!isPackageManifest(pkg)) throw new Error(`${dir}/package.json has no name or description`)
    return pkg.private ? [] : [{ dir, pkg }]
  })
  return table(['Package', 'What it is', 'Versioning', 'Reference'], published.map(({ dir, pkg }) => [
    code(pkg.name),
    cell(pkg.description),
    pkg.versionPolicy === 'independent' ? 'independent' : 'platform',
    `[README](${repository}/blob/main/${dir}/README.md)`,
  ]))
}
