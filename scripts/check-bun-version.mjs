#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * `packageManager` in package.json is the one Bun version. Workflows read it; Dockerfiles
 * cannot, so their BUN_VERSION default must match, and @types/bun must not run ahead of it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const version = /^bun@(\d+\.\d+\.\d+)$/.exec(root.packageManager ?? '')?.[1];
if (!version) {
  console.error('package.json packageManager must be "bun@<x.y.z>"');
  process.exit(1);
}
const problems = [];

for (const file of ['Dockerfile', 'backend/Dockerfile']) {
  const text = readFileSync(file, 'utf8');
  const arg = /^ARG BUN_VERSION=(\S+)$/m.exec(text)?.[1];
  if (arg !== version) problems.push(`${file}: ARG BUN_VERSION=${arg ?? '<missing>'}, expected ${version}`);
  for (const [, tag] of text.matchAll(/^FROM oven\/bun:(\S+)/gm)) {
    if (!tag.startsWith('${BUN_VERSION}')) problems.push(`${file}: FROM oven/bun:${tag} bypasses BUN_VERSION`);
  }
}

const workflowDirs = ['.github/workflows', '.github/actions'];
for (const dir of workflowDirs) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, 'utf8');
    for (const [, pinned] of text.matchAll(/^\s*bun-version:\s*['"]?(\d[^'"\s]*)/gm)) {
      problems.push(`${file}: bun-version ${pinned} is hardcoded; use bun-version-file: package.json`);
    }
    for (const [step] of text.matchAll(/uses: oven-sh\/setup-bun@\S+(?:\r?\n\s+with:(?:\r?\n\s{6,}\S.*)+)?/g)) {
      if (!/bun-version(-file)?:/.test(step)) problems.push(`${file}: setup-bun without a version floats to latest`);
    }
  }
}

for (const file of ['backend/package.json', 'packages/cli/package.json']) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const types = pkg.devDependencies?.['@types/bun'];
  if (types && types !== `~${version}`) {
    problems.push(`${file}: @types/bun ${types} should be ~${version} so types never outrun the runtime`);
  }
  if (pkg.devDependencies?.['bun-types']) problems.push(`${file}: bun-types is redundant next to @types/bun`);
}

if (problems.length) {
  console.error(`Bun version drift (runtime ${version}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Bun ${version} everywhere`);
