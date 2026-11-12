// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export type RegionRenderer = (arg: string) => string

const REGION = /<!-- generated:([a-z-]+)(?: ([^>]*?))? -->[\s\S]*?<!-- \/generated:\1 -->/g

export function renderRegions(doc: string, renderers: Readonly<Record<string, RegionRenderer>>, label: string): string {
  return doc.replace(REGION, (_, kind: string, arg: string | undefined) => {
    const render = renderers[kind]
    if (!render) throw new Error(`${label}: no generator for region "${kind}"`)
    const head = arg ? `<!-- generated:${kind} ${arg} -->` : `<!-- generated:${kind} -->`
    return `${head}\n${render(arg ?? '').trimEnd()}\n<!-- /generated:${kind} -->`
  })
}

export function hasRegions(doc: string): boolean {
  return new RegExp(REGION.source).test(doc)
}

const CELL_ESCAPES: Readonly<Record<string, string>> = { '|': '\\|', '<': '&lt;', '>': '&gt;' }

export function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[|<>]/g, c => CELL_ESCAPES[c] ?? c)
}

export function code(text: string): string {
  return `\`${text}\``
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}
