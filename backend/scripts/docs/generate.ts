// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { loadContract, renderDocs, docsSections } from '@quotentiroler/guido-cli/contract'
import { INTROSPECTED_CONTEXT } from '../../src/routes/auth/oauth/introspection'
import { PROTECTED_ROUTES } from '../../src/lib/mcp-endpoint-config'
import { adminRoutes, apiContract, parseRouteRefs, referenceTables, routesTable, toolNamesTable } from './admin-api'
import { cliRegion } from './cli'
import { code, hasRegions, renderRegions, type RegionRenderer } from './regions'
import { staleReferences, type StaleReference } from './references'

const ROOT = join(import.meta.dir, '..', '..', '..')
const API_CONTRACT = 'docs/public/admin-api.json'
const GUIDO_MARKER = '<!-- guido:fields #'

const check = process.argv.includes('--check')
const routes = adminRoutes()
const contract = loadContract(join(ROOT, 'guido.contract.json'))
const guidoDocs = contract.config.generate?.docs?.path

const renderers: Readonly<Record<string, RegionRenderer>> = {
  'admin-api': () => referenceTables(routes),
  'admin-routes': arg => routesTable(routes, arg),
  'tool-names': arg => toolNamesTable(routes, parseRouteRefs(arg)),
  'protected-tools': () => toolNamesTable(routes, PROTECTED_ROUTES),
  'launch-context-claims': () => INTROSPECTED_CONTEXT.map(code).join(', '),
  'cli-help': () => cliRegion(ROOT, 'cli-help'),
  'cli-settings': () => cliRegion(ROOT, 'cli-settings'),
}

const toLf = (text: string) => text.replace(/\r\n/g, '\n')
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

function guidoTables(doc: string): string {
  const anchors = new Set(docsSections(doc).map(([anchor]) => anchor))
  const fields = contract.template.fields.filter(field => anchors.has(`#${(field.link ?? '').split('#')[1] ?? ''}`))
  return renderDocs(doc, fields)
}

function render(file: string, doc: string): string {
  let out = hasRegions(doc) ? renderRegions(doc, renderers, file) : doc
  if (file !== guidoDocs && out.includes(GUIDO_MARKER)) out = guidoTables(out)
  return out
}

interface Output {
  file: string
  current: string
  next: string
}

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: ROOT })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  return listed.stdout.toString().split('\0').filter(file => file && existsSync(join(ROOT, file)))
}

function outputs(): Output[] {
  const docs = trackedMarkdown().map(file => {
    const current = readFileSync(join(ROOT, file), 'utf8')
    return { file, current, next: render(file, toLf(current)).replace(/\n/g, eolOf(current)) }
  })
  const contractPath = join(ROOT, API_CONTRACT)
  const currentContract = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : ''
  return [...docs, { file: API_CONTRACT, current: currentContract, next: apiContract(routes).replace(/\n/g, eolOf(currentContract)) }]
}

const results = outputs()
const changed = results.filter(({ current, next }) => toLf(current) !== toLf(next))
const stale: StaleReference[] = results
  .filter(({ file }) => file.endsWith('.md'))
  .flatMap(({ file, next }) => staleReferences(file, toLf(next), routes))

for (const { file, line, reference } of stale) {
  console.error(`::error file=${file},line=${line}::${reference} is not an admin route or MCP tool`)
}

if (check) {
  for (const { file } of changed) console.error(`::error file=${file}::out of date, run bun run docs:generate`)
  if (changed.length > 0 || stale.length > 0) process.exit(1)
  console.log(`docs: ${results.length} files current, ${routes.length} admin routes referenced correctly`)
} else {
  for (const { file, next } of changed) {
    writeFileSync(join(ROOT, file), next)
    console.log(`docs: wrote ${file}`)
  }
  if (stale.length > 0) process.exit(1)
}
process.exit(0)
