// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export interface StaleReference {
  file: string
  line: number
  reference: string
}

export interface AppRoute {
  method: string
  path: string
}

const ROUTE_MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\b`?\s*(?:\|\s*)?`?(\/[^`\s?#|)'"\],]*)/g
const TOOL_MENTION = /`((?:get|create|update|delete)_admin_[A-Za-z0-9_-]*)`/g
const SCRIPT_MENTION = /\bbun run (\w[\w:.-]*)(?![\w/:.-])/g
const FILE_ARGUMENT = /\.(?:[cm]?[jt]sx?)$/
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const KEYCLOAK_ADMIN_API = ['/admin/realms', '/admin/serverinfo']
const OPEN_ENDED = /\/(?:\*|\.\.\.)$/

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const isParam = (segment: string) => segment.startsWith(':') || /^\{\w+\}$/.test(segment)
const isRest = (segment: string) => segment === '*' || segment === '...'

function pathPattern(path: string): RegExp {
  const segments = path.replace(/\/+$/, '').split('/').map(segment => {
    if (isRest(segment)) return '.*'
    return isParam(segment) ? '[^/]+' : escapeRegExp(segment)
  })
  return new RegExp(`^${segments.join('/')}/?$`)
}

function samplePath(path: string): string {
  return path.split('/').map(segment => (isRest(segment) || isParam(segment) ? 'x' : segment)).join('/')
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function withoutComments(text: string): string {
  return text.replace(HTML_COMMENT, comment => comment.replace(/[^\n]/g, ' '))
}

export class ReferenceIndex {
  private readonly patterns: { method: string; path: string; pattern: RegExp }[]
  private readonly owned: ReadonlySet<string>

  constructor(
    routes: readonly AppRoute[],
    private readonly tools: ReadonlySet<string>,
    private readonly scripts: ReadonlySet<string>,
  ) {
    this.patterns = routes.map(route => ({ method: route.method, path: route.path, pattern: pathPattern(route.path) }))
    this.owned = new Set(routes.map(route => route.path.split('/')[1] ?? '').filter(segment => segment && !segment.startsWith(':')))
  }

  private routeExists(method: string, mentioned: string): boolean {
    const path = mentioned.replace(/\/+$/, '') || '/'
    const methodMatches = (candidate: string) => candidate === method || candidate === 'ALL'
    if (OPEN_ENDED.test(path)) {
      const mentioned = pathPattern(path)
      return this.patterns.some(route => methodMatches(route.method) && mentioned.test(samplePath(route.path)))
    }
    return this.patterns.some(route => methodMatches(route.method) && route.pattern.test(path))
  }

  private isOwned(path: string): boolean {
    return this.owned.has(path.split('/')[1] ?? '') && !KEYCLOAK_ADMIN_API.some(prefix => path.startsWith(prefix))
  }

  stale(file: string, text: string): StaleReference[] {
    const prose = withoutComments(text)
    const stale: StaleReference[] = []
    for (const match of prose.matchAll(ROUTE_MENTION)) {
      const [, method = '', path = ''] = match
      if (this.isOwned(path) && !this.routeExists(method, path)) {
        stale.push({ file, line: lineAt(prose, match.index), reference: `${method} ${path}` })
      }
    }
    for (const match of prose.matchAll(TOOL_MENTION)) {
      const [, tool = ''] = match
      if (!this.tools.has(tool)) stale.push({ file, line: lineAt(prose, match.index), reference: tool })
    }
    for (const match of prose.matchAll(SCRIPT_MENTION)) {
      const [, script = ''] = match
      if (!FILE_ARGUMENT.test(script) && !this.scripts.has(script)) {
        stale.push({ file, line: lineAt(prose, match.index), reference: `bun run ${script}` })
      }
    }
    return stale
  }
}
