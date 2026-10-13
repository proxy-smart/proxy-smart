#!/usr/bin/env node
/**
 * Assert every `${env.X}` a login theme depends on is actually set where that theme is deployed.
 *
 * Keycloak substitutes `${env.NAME}` in theme.properties at theme load. When NAME is unset it
 * does not fail, or warn — it emits the placeholder verbatim, and the theme silently renders
 * something wrong. That is how the error page's only link came to be a 403: the fallback had no
 * configured destination and nothing anywhere said so.
 *
 * The theme is the source of truth. This reads the placeholders back out of it rather than
 * keeping a hand-written list, so adding a new `${env.X}` to a theme automatically becomes a
 * deploy requirement instead of a thing someone has to remember.
 *
 * Targets are the files that define the Keycloak container's environment for one deployment:
 * docker-compose.beta.yml for the VPS, the Keycloak stack in proxy-smart-infra for ECS. The
 * infra ones live in a private repo that CI checks out to infra/, which is why this takes paths
 * rather than assuming any.
 *
 *   node scripts/check-theme-env.mjs docker-compose.beta.yml
 *   node scripts/check-theme-env.mjs infra/lib infra/bin
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const THEMES_DIR = 'keycloak/themes';
const SEARCHABLE = new Set(['.ts', '.js', '.mjs', '.yml', '.yaml', '.json', '.tf', '.env']);

function walk(path, keep) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const child = join(path, entry.name);
    if (entry.isDirectory()) return walk(child, keep);
    return keep(child) ? [child] : [];
  });
}

/** Every `${env.NAME}` any theme.properties depends on, with the themes that want it. */
function requiredEnv() {
  const required = new Map();
  for (const file of walk(THEMES_DIR, (f) => f.endsWith('theme.properties'))) {
    // Comments in a .properties file explain the placeholders, so they mention them too.
    const declarations = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const [, name] of declarations.matchAll(/\$\{env\.([A-Z0-9_]+)\}/g)) {
      if (!required.has(name)) required.set(name, new Set());
      required.get(name).add(file);
    }
  }

  return required;
}

/**
 * Whether a target actually ASSIGNS the variable.
 *
 * A mention is not an assignment — every one of these files also names the variable in a
 * comment explaining what it is for — so require a `:` or `=` and a non-empty value after it.
 */
function assignsVariable(text, name) {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
    const at = trimmed.indexOf(name);
    if (at === -1) return false;
    const after = trimmed.slice(at + name.length).replace(/^["'`]/, '').trimStart();
    if (!after.startsWith(':') && !after.startsWith('=')) return false;
    return after.slice(1).trim().length > 0;
  });
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: check-theme-env.mjs <file-or-directory>...');
  process.exit(2);
}

const required = requiredEnv();
let failed = false;

// Each argument is one deployment, so each must provide everything on its own.
for (const target of targets) {
  const files = walk(target, (f) => SEARCHABLE.has(extname(f)));
  const haystack = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const missing = [...required].filter(([name]) => !assignsVariable(haystack, name));

  if (missing.length > 0) {
    failed = true;
    console.error(`✖ Theme environment not provided by ${target}:`);
    for (const [name, themes] of missing) console.error(`  ${name} — required by ${[...themes].join(', ')}`);
    continue;
  }
  const names = [...required.keys()];
  console.log(`✔ ${names.length ? names.join(', ') : 'no theme environment'} provided by ${target} (${files.length} files)`);
}

if (failed) {
  console.error('\nKeycloak emits an unset ${env.X} verbatim, so the theme would render a broken');
  console.error('value rather than fail. Set it on the Keycloak container for that deployment.');
  process.exit(1);
}
