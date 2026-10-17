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

interface HtmlResponseInit {
  status?: number
  headers?: Record<string, string>
}

export function htmlResponse(element: JSX.Element, init: HtmlResponseInit = {}): Response {
  return new Response(renderDocument(element), {
    status: init.status,
    headers: { ...init.headers, 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
