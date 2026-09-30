#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// REUSE-IgnoreStart
// This file's own SPDX header is above; the body below literally contains the
// SPDX token strings it reads/writes, so it is ignored to stop `reuse lint`
// from parsing those occurrences as license expressions.

/**
 * SPDX header tool.
 *
 * The repository is already REUSE-compliant via the catch-all in REUSE.toml, so
 * per-file headers are optional and added incrementally. This helper adds and
 * verifies them without a mass edit.
 *
 * Usage:
 *   node scripts/spdx.mjs --add <file...>       add headers to the given files
 *   node scripts/spdx.mjs --add --staged        add headers to git-staged source files
 *   node scripts/spdx.mjs --check <file...>      exit non-zero if any lack a header
 *   node scripts/spdx.mjs --check --staged       check git-staged source files (CI/hook gate)
 *
 * Config comes from REUSE.toml (single source of truth) so the identifier and
 * copyright are never hardcoded here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [open, close] comment delimiters per extension. Extensions absent here have no
// comment syntax (e.g. JSON) and are neither checked nor edited.
const SLASH = ['//', ''];
const HASH = ['#', ''];
const COMMENT = {
  '.ts': SLASH, '.tsx': SLASH, '.mts': SLASH, '.cts': SLASH,
  '.js': SLASH, '.jsx': SLASH, '.mjs': SLASH, '.cjs': SLASH,
  '.css': ['/*', ' */'], '.scss': SLASH,
  '.sh': HASH, '.bash': HASH, '.py': HASH, '.yml': HASH, '.yaml': HASH, '.toml': HASH,
};

// Lines that must stay first in the file, so the header goes after them.
const LEADING_LINE = /^(#!|@charset\s)/;

// Paths that must never receive an injected header (generated, vendored, config).
const SKIP_PATTERNS = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)coverage\//,
  /\.d\.ts$/, /(^|\/)api-client(\/|\.)/, /\.tgz$/,
];

function readReuseConfig() {
  const toml = fs.readFileSync(path.join(ROOT, 'REUSE.toml'), 'utf8');
  const block = toml.split(/\[\[annotations\]\]/).find((b) => /path\s*=\s*"\*\*"/.test(b));
  if (!block) throw new Error('REUSE.toml: could not find the "**" catch-all annotation');
  const id = block.match(/SPDX-License-Identifier\s*=\s*"([^"]+)"/)?.[1];
  const copyright = block.match(/SPDX-FileCopyrightText\s*=\s*"([^"]+)"/)?.[1];
  if (!id || !copyright) throw new Error('REUSE.toml: catch-all is missing license id or copyright');
  return { id, copyright };
}

function headerFor([open, close], { id, copyright }) {
  return `${open} SPDX-FileCopyrightText: ${copyright}${close}\n${open} SPDX-License-Identifier: ${id}${close}\n`;
}

function shouldSkip(rel) {
  return SKIP_PATTERNS.some((re) => re.test(rel.replace(/\\/g, '/')));
}

function hasHeader(text) {
  return /SPDX-License-Identifier:/.test(text.slice(0, 512));
}

function stagedSourceFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((f) => Object.prototype.hasOwnProperty.call(COMMENT, path.extname(f)));
}

function addHeader(rel, cfg) {
  const comment = COMMENT[path.extname(rel)];
  if (!comment) return 'skipped';
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return 'missing';
  let text = fs.readFileSync(abs, 'utf8');
  if (hasHeader(text)) return 'present';
  const header = headerFor(comment, cfg);
  if (LEADING_LINE.test(text)) {
    const nl = text.indexOf('\n');
    text = `${text.slice(0, nl + 1)}${header}${text.slice(nl + 1)}`;
  } else {
    text = `${header}\n${text}`;
  }
  fs.writeFileSync(abs, text);
  return 'added';
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--add') ? 'add' : argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.error('Usage: spdx.mjs (--add|--check) [--staged] [file...]');
    process.exit(2);
  }
  const cfg = readReuseConfig();
  const explicit = argv.filter((a) => !a.startsWith('--'));
  let files = argv.includes('--staged') ? stagedSourceFiles() : explicit;
  files = files
    .map((f) => path.relative(ROOT, path.resolve(ROOT, f)).replace(/\\/g, '/'))
    .filter((f) => !shouldSkip(f));

  if (files.length === 0) {
    console.log('spdx: no matching source files.');
    return;
  }

  if (mode === 'add') {
    const counts = {};
    for (const f of files) {
      const r = addHeader(f, cfg);
      counts[r] = (counts[r] || 0) + 1;
      if (r === 'added') console.log(`  + ${f}`);
    }
    console.log(`spdx --add: ${JSON.stringify(counts)}`);
    return;
  }

  // check
  const missing = files.filter((f) => {
    if (shouldSkip(f)) return false;
    const abs = path.join(ROOT, f);
    return fs.existsSync(abs) && !hasHeader(fs.readFileSync(abs, 'utf8'));
  });
  if (missing.length) {
    console.error('spdx: missing SPDX header in:');
    for (const f of missing) console.error(`  - ${f}`);
    console.error(`\nRun: node scripts/spdx.mjs --add ${missing.join(' ')}`);
    process.exit(1);
  }
  console.log(`spdx: all ${files.length} checked file(s) have headers.`);
}

main();
// REUSE-IgnoreEnd
