// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { normalizePath, type AdminRoute } from './admin-api'

export interface StaleReference {
  file: string
  line: number
  reference: string
}

const ROUTE_MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\b`?\s*(?:\|\s*)?`?(\/admin\/[^`\s?#|)'",]*)/g
const TOOL_MENTION = /`((?:get|create|update|delete)_admin_[A-Za-z0-9_-]*)`/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const KEYCLOAK_ADMIN_API = ['/admin/realms', '/admin/serverinfo']

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function withoutComments(text: string): string {
  return text.replace(HTML_COMMENT, comment => comment.replace(/[^\n]/g, ' '))
}

export function staleReferences(file: string, text: string, routes: readonly AdminRoute[]): StaleReference[] {
  const known = new Set(routes.map(route => `${route.method} ${normalizePath(route.path)}`))
  const tools = new Set(routes.map(route => route.tool))
  const prose = withoutComments(text)
  const stale: StaleReference[] = []
  for (const match of prose.matchAll(ROUTE_MENTION)) {
    const [, method = '', path = ''] = match
    if (KEYCLOAK_ADMIN_API.some(prefix => path.startsWith(prefix))) continue
    if (!known.has(`${method} ${normalizePath(path)}`)) {
      stale.push({ file, line: lineAt(prose, match.index), reference: `${method} ${path}` })
    }
  }
  for (const match of prose.matchAll(TOOL_MENTION)) {
    const [, tool = ''] = match
    if (!tools.has(tool)) stale.push({ file, line: lineAt(prose, match.index), reference: tool })
  }
  return stale
}
