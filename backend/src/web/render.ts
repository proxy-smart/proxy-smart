// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { JSX } from 'hono/jsx/jsx-runtime'

export function renderToString(element: JSX.Element): string {
  if (element instanceof Promise) throw new Error('renderToString: async components are not supported')
  const html: unknown = element.toString()
  if (typeof html !== 'string') throw new Error('renderToString: async components are not supported')
  return html
}

export function renderDocument(element: JSX.Element): string {
  return `<!DOCTYPE html>${renderToString(element)}`
}

export function htmlResponse(element: JSX.Element, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(renderDocument(element), { ...init, headers })
}

export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  if (/^\/(?![/\\])/.test(value)) return value
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
