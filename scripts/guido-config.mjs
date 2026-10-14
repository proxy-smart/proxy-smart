#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * proxy-smart.guido.json is the configuration contract: every environment variable the backend
 * reads. This script derives the env docs tables and .env.example from it and checks that the
 * code, the template and the access posture agree.
 *
 *   node scripts/guido-config.mjs generate
 *   node scripts/guido-config.mjs check
 *   node scripts/guido-config.mjs validate
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TEMPLATE = join(ROOT, 'proxy-smart.guido.json')
const DOCS = join(ROOT, 'docs', 'environment-variables.md')
const ENV_EXAMPLE = join(ROOT, '.env.example')
const POSTURE = join(ROOT, 'backend', 'src', 'lib', 'access-posture.json')
const BACKEND_SRC = join(ROOT, 'backend', 'src')

/** Template fields whose default is the access posture, by posture key. */
const POSTURE_FIELDS = {
  CONSENT_MODE: 'consent',
  SCOPE_ENFORCEMENT_MODE: 'scopeEnforcement',
  ROLE_BASED_FILTERING_MODE: 'roleBasedFiltering',
  FHIR_AUDIENCE_ENFORCEMENT: 'fhirAudience',
  TENANT_ISOLATION_MODE: 'tenantIsolation',
}

/** The settings each environment ships, and the ruleset they must satisfy. */
const ENV_TARGETS = [
  ['.env.example', null, 'Deployed'],
  ['docker-compose.beta.yml', 'backend', 'Deployed'],
  ['docker-compose.prod.yml', 'backend', 'Deployed'],
  ['docker-compose.development.yml', 'app', 'Dependencies'],
]

const MARKER = /<!-- guido:fields (#[a-z0-9-]+) -->[\s\S]*?<!-- \/guido:fields -->/g

const read = (path) => readFileSync(path, 'utf8')
const lf = (text) => text.replace(/\r\n/g, '\n')
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')
const template = () => JSON.parse(read(TEMPLATE))
const anchorOf = (field) => (field.link ?? '').split('#')[1] ?? ''
const isEmpty = (value) => value === '' || (Array.isArray(value) && value.length === 0)

function renderValue(value) {
  if (isEmpty(value)) return '--'
  return `\`${Array.isArray(value) ? value.join(',') : String(value)}\``
}

function fieldsTable(fields) {
  const rows = fields.map((f) => `| \`${f.name}\` | ${f.info.replace(/\|/g, '\\|')} | ${renderValue(f.value)} |`)
  return ['| Variable | Description | Default |', '|---|---|---|', ...rows].join('\n')
}

/** The docs page with every marked table regenerated; prose around the tables stays hand-written. */
function renderDocs(fields) {
  const docs = lf(read(DOCS))
  const used = new Set()
  const out = docs.replace(MARKER, (_, anchor) => {
    const group = fields.filter((f) => `#${anchorOf(f)}` === anchor)
    if (group.length === 0) throw new Error(`docs marker ${anchor} has no template fields`)
    used.add(anchor)
    return `<!-- guido:fields ${anchor} -->\n${fieldsTable(group)}\n<!-- /guido:fields -->`
  })
  const orphans = [...new Set(fields.map((f) => `#${anchorOf(f)}`))].filter((a) => !used.has(a))
  if (orphans.length) throw new Error(`template fields link to sections with no docs marker: ${orphans.join(', ')}`)
  return out
}

/** Docs sections in page order: [anchor, heading]. */
function sections() {
  const docs = lf(read(DOCS))
  const result = []
  let heading = ''
  for (const line of docs.split('\n')) {
    const h = line.match(/^##+\s+(.*)$/)
    if (h) heading = h[1]
    const m = line.match(/^<!-- guido:fields (#[a-z0-9-]+) -->$/)
    if (m) result.push([m[1], heading])
  }
  return result
}

function wrap(text, width = 88) {
  const lines = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (current && current.length + word.length + 1 > width) { lines.push(current); current = word } else current = current ? `${current} ${word}` : word
  }
  if (current) lines.push(current)
  return lines
}

/** Fields every deployment sets: the unconditional targets of the Deployed ruleset. */
function deployedRequired(tpl) {
  const deployed = tpl.ruleSets.find((r) => r.name === 'Deployed')
  return new Set((deployed?.rules ?? []).filter((r) => !r.conditions?.length).flatMap((r) => r.targets.map((t) => t.name)))
}

function renderEnvExample(tpl) {
  const required = deployedRequired(tpl)
  const out = [
    '# Proxy Smart environment variables',
    '# Generated from proxy-smart.guido.json by `bun run config:generate`; edit the template, not this file.',
    '# Copy to .env. Uncommented lines are what every deployment sets; the rest show their defaults.',
  ]
  for (const [anchor, heading] of sections()) {
    const group = tpl.fields.filter((f) => `#${anchorOf(f)}` === anchor)
    out.push('', `# ── ${heading} ${'─'.repeat(Math.max(3, 60 - heading.length))}`)
    for (const f of group) {
      out.push(...wrap(f.info).map((l) => `# ${l}`))
      const value = required.has(f.name) ? f.example : Array.isArray(f.value) ? f.value.join(',') : String(f.value)
      out.push(required.has(f.name) ? `${f.name}=${value}` : `# ${f.name}=${value}`)
    }
  }
  return out.join('\n') + '\n'
}

/** Every env var name the backend reads: process.env.X and the positiveIntEnv('X', ...) style helpers. */
function codeVariables() {
  const names = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts') && !path.includes('.test.')) {
        const text = read(path)
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1])
        for (const m of text.matchAll(/[A-Za-z]+Env\('([A-Z][A-Z0-9_]+)'/g)) names.add(m[1])
      }
    }
  }
  walk(BACKEND_SRC)
  return names
}

function check() {
  const tpl = template()
  const problems = []
  const docs = read(DOCS)
  if (lf(docs) !== renderDocs(tpl.fields)) problems.push('docs/environment-variables.md is stale: run `bun run config:generate`')
  if (lf(read(ENV_EXAMPLE)) !== renderEnvExample(tpl)) problems.push('.env.example is stale: run `bun run config:generate`')

  const declared = new Set(tpl.fields.map((f) => f.name))
  const read_ = codeVariables()
  const undeclared = [...read_].filter((n) => !declared.has(n)).sort()
  const unread = [...declared].filter((n) => !read_.has(n)).sort()
  if (undeclared.length) problems.push(`read by the backend but missing from proxy-smart.guido.json: ${undeclared.join(', ')}`)
  if (unread.length) problems.push(`in proxy-smart.guido.json but never read by the backend: ${unread.join(', ')}`)

  const posture = JSON.parse(read(POSTURE))
  for (const [name, key] of Object.entries(POSTURE_FIELDS)) {
    const field = tpl.fields.find((f) => f.name === name)
    if (field && field.value !== posture[key]) problems.push(`${name} defaults to ${field.value} in the template but ${posture[key]} in access-posture.json`)
  }

  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`)
    process.exit(1)
  }
  console.log(`proxy-smart.guido.json: ${tpl.fields.length} variables, docs and .env.example current, posture consistent`)
}

function generate() {
  const tpl = template()
  const docs = read(DOCS)
  writeFileSync(DOCS, renderDocs(tpl.fields).replace(/\n/g, eolOf(docs)))
  const env = read(ENV_EXAMPLE)
  writeFileSync(ENV_EXAMPLE, renderEnvExample(tpl).replace(/\n/g, eolOf(env)))
  console.log(`generated ${relative(ROOT, DOCS)} and ${relative(ROOT, ENV_EXAMPLE)} from ${tpl.fields.length} variables`)
}

/** A compose service's environment as .env lines: ${VAR:-x} becomes x, a value set at deploy time a placeholder. */
function composeEnv(composeFile, service) {
  const env = yaml.load(read(join(ROOT, composeFile)))?.services?.[service]?.environment
  if (!env) throw new Error(`${composeFile} has no environment for service ${service}`)
  const entries = (Array.isArray(env) ? env.map((line) => line.split(/=(.*)/s).slice(0, 2)) : Object.entries(env))
    // A combined dev container also builds the frontend; VITE_* belong to it, not the backend contract.
    .filter(([key]) => !key.startsWith('VITE_'))
  const resolve = (value) =>
    String(value ?? '').replace(/\$\{([A-Z0-9_]+)(?::?([-?])([^}]*))?\}/g, (_, _name, op, rest) => (op === '-' ? rest : 'set-at-deploy'))
  return entries.map(([key, value]) => `${key}=${resolve(value)}`).join('\n') + '\n'
}

function validateEnvironments() {
  const dir = mkdtempSync(join(tmpdir(), 'guido-env-'))
  let failed = false
  for (const [file, service, ruleset] of ENV_TARGETS) {
    const out = join(dir, `${file}.env`)
    writeFileSync(out, service ? composeEnv(file, service) : read(join(ROOT, file)))
    console.log(`\n${file}${service ? ` (${service})` : ''} against ${ruleset}:`)
    try {
      execFileSync('guido-validate-settings', [TEMPLATE, out, '--ruleset', ruleset, '--strict'], { stdio: 'inherit', shell: process.platform === 'win32' })
    } catch {
      failed = true
    }
  }
  if (failed) process.exit(1)
}

const [command] = process.argv.slice(2)
if (command === 'generate') generate()
else if (command === 'check') check()
else if (command === 'validate') validateEnvironments()
else {
  console.error('usage: guido-config.mjs generate | check | validate')
  process.exit(2)
}
