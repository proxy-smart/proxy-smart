// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import '../../src/routes/admin'
import { getToolRegistry, proxySmartResourceUri } from '../../src/lib/ai/tool-registry'
import { cell, code, table } from './regions'

export interface AdminRoute {
  method: string
  path: string
  tool: string
  summary: string
  resource?: string
}

export const ADMIN_PREFIX = '/admin/'

export function adminRoutes(): AdminRoute[] {
  return [...getToolRegistry()]
    .map(([tool, meta]) => ({
      method: meta.method,
      path: meta.path,
      tool,
      summary: meta.title ?? meta.description ?? '',
      ...(meta.method === 'GET' ? { resource: proxySmartResourceUri(meta.path) } : {}),
    }))
    .sort((a, b) => routeKey(a.path, a.method).localeCompare(routeKey(b.path, b.method)))
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function routeKey(path: string, method: string): string {
  return `${normalizePath(path)} ${METHOD_ORDER.indexOf(method)}`
}

export function normalizePath(path: string): string {
  return path.replace(/\/+$/, '').replace(/\{(\w+)\}/g, ':$1').replace(/:\w+/g, ':')
}

export function sectionOf(path: string): string {
  return path.slice(ADMIN_PREFIX.length).split('/')[0] ?? ''
}

function withPrefixes(routes: readonly AdminRoute[], arg: string): AdminRoute[] {
  const prefixes = arg.split(/\s+/).filter(Boolean)
  if (prefixes.length === 0) throw new Error('admin-routes needs at least one path prefix')
  return prefixes.flatMap(prefix => {
    const matched = routes.filter(route => normalizePath(route.path).startsWith(normalizePath(prefix)))
    if (matched.length === 0) throw new Error(`admin-routes: no admin route starts with ${prefix}`)
    return matched
  })
}

export function routesTable(routes: readonly AdminRoute[], arg: string): string {
  return table(
    ['Method', 'Path', 'Summary'],
    withPrefixes(routes, arg).map(route => [code(route.method), code(route.path), cell(route.summary)]),
  )
}

function mcpCell(route: AdminRoute): string {
  return route.resource ? `resource ${code(route.resource)}` : `tool ${code(route.tool)}`
}

export function referenceTables(routes: readonly AdminRoute[]): string {
  const sections = [...new Set(routes.map(route => sectionOf(route.path)))].sort()
  return sections.map(section => {
    const rows = routes.filter(route => sectionOf(route.path) === section)
    return [
      `### ${code(`${ADMIN_PREFIX}${section}`)}`,
      '',
      table(['Method', 'Path', 'Summary', 'MCP'], rows.map(route => [
        code(route.method),
        code(route.path),
        cell(route.summary),
        mcpCell(route),
      ])),
    ].join('\n')
  }).join('\n\n')
}

export interface RouteRef {
  method: string
  path: string
}

export function parseRouteRefs(arg: string): RouteRef[] {
  return arg.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [method = '', path = ''] = entry.split(/\s+/)
    return { method, path }
  })
}

export function toolNamesTable(routes: readonly AdminRoute[], wanted: readonly RouteRef[]): string {
  return table(['Route', 'Tool'], wanted.map(({ method, path }) => {
    const route = routes.find(r => r.method === method && r.path === path)
    if (!route) throw new Error(`no admin route ${method} ${path}`)
    return [code(`${route.method} ${route.path}`), code(route.tool)]
  }))
}

export function apiContract(routes: readonly AdminRoute[]): string {
  return `${JSON.stringify({ routes }, null, 2)}\n`
}
