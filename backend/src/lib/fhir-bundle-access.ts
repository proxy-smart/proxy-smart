// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Batch and transaction Bundles at the server base, authorised entry by entry.

import { STATUS_CODES } from 'http'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { logger } from './logger'
import { ERASE_OPERATION } from './fhir-erasure'
import { parseFhirPath } from './fhir-capabilities'
import { issueCodeForStatus, operationOutcome, refusalDiagnostics, toOperationOutcome } from './fhir-operation-outcome'
import type { FhirAuthorization, FhirProxyResult, FhirRequestInput } from './fhir-request-pipeline'
import { isRecord } from './type-guards'

const BundleEntryRequest = Type.Object({
  method: Type.Union(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => Type.Literal(m))),
  url: Type.String({ minLength: 1 }),
  ifNoneMatch: Type.Optional(Type.String()),
  ifModifiedSince: Type.Optional(Type.String()),
  ifMatch: Type.Optional(Type.String()),
  ifNoneExist: Type.Optional(Type.String()),
}, { additionalProperties: true })

const BundleEntry = Type.Object({
  fullUrl: Type.Optional(Type.String()),
  resource: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  request: BundleEntryRequest,
}, { additionalProperties: true })

const RequestBundle = Type.Object({
  resourceType: Type.Literal('Bundle'),
  type: Type.Union([Type.Literal('batch'), Type.Literal('transaction')]),
  entry: Type.Optional(Type.Array(Type.Unknown())),
}, { additionalProperties: true })

type BundleEntryType = Static<typeof BundleEntry>

const CONDITIONAL_HEADERS: ReadonlyArray<[keyof Static<typeof BundleEntryRequest>, string]> = [
  ['ifNoneMatch', 'if-none-match'],
  ['ifModifiedSince', 'if-modified-since'],
  ['ifMatch', 'if-match'],
  ['ifNoneExist', 'if-none-exist'],
]

const PATH_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/

export interface BundleContext {
  /** The proxy's own base URL for this server, against which absolute entry URLs are resolved. */
  proxyBase: string
  maxEntries: number
  headers: Headers
  authorize: (req: FhirRequestInput) => Promise<FhirAuthorization>
  execute: (req: FhirRequestInput) => Promise<FhirProxyResult>
  forwardTransaction: (body: string) => Promise<FhirProxyResult>
}

type EntryParse = { ok: true; req: FhirRequestInput } | { ok: false; status: number; message: string }

function result(status: number, body: unknown): FhirProxyResult {
  return { status, headers: { 'content-type': 'application/fhir+json' }, body }
}

function statusLine(status: number): string {
  const text = STATUS_CODES[status]
  return text ? `${status} ${text}` : String(status)
}

/** Resolve an entry's request.url to a path and query relative to the server base. */
export function resolveEntryUrl(url: string, proxyBase: string): { resourcePath: string; queryString: string } | null {
  let relative = url
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    if (!url.startsWith(`${proxyBase}/`)) return null
    relative = url.slice(proxyBase.length + 1)
  }
  relative = relative.replace(/^\/+/, '')
  if (relative.includes('#')) return null
  const q = relative.indexOf('?')
  const resourcePath = q === -1 ? relative : relative.slice(0, q)
  const queryString = q === -1 ? '' : relative.slice(q)
  const segments = resourcePath.split('/')
  if (!resourcePath || segments.some((s) => !PATH_SEGMENT_RE.test(s) || s === '.' || s === '..')) return null
  return { resourcePath, queryString }
}

function entryBody(entry: BundleEntryType): { body?: string; contentType?: string } | null {
  const resource = entry.resource
  if (!resource) return {}
  if (entry.request.method === 'PATCH' && resource.resourceType === 'Binary') {
    if (typeof resource.data !== 'string' || typeof resource.contentType !== 'string') return null
    return { body: Buffer.from(resource.data, 'base64').toString('utf-8'), contentType: resource.contentType }
  }
  return { body: JSON.stringify(resource), contentType: 'application/fhir+json' }
}

function parseEntry(raw: unknown, ctx: BundleContext): EntryParse {
  if (!Value.Check(BundleEntry, raw)) {
    return { ok: false, status: 400, message: 'Each entry needs request.method (GET, POST, PUT, PATCH or DELETE) and request.url.' }
  }
  const target = resolveEntryUrl(raw.request.url, ctx.proxyBase)
  if (!target) {
    return { ok: false, status: 400, message: `request.url '${raw.request.url}' is not a FHIR path on this server.` }
  }
  const content = entryBody(raw)
  if (!content) return { ok: false, status: 400, message: 'A PATCH Binary needs data and contentType.' }
  if (['POST', 'PUT'].includes(raw.request.method) && content.body === undefined && !target.resourcePath.endsWith('_search')) {
    return { ok: false, status: 400, message: `${raw.request.method} entries need a resource.` }
  }

  const headers = new Headers(ctx.headers)
  headers.delete('content-type')
  for (const [field, header] of CONDITIONAL_HEADERS) {
    const value = raw.request[field]
    if (typeof value === 'string') headers.set(header, value)
  }
  if (content.contentType) headers.set('content-type', content.contentType)
  return { ok: true, req: { method: raw.request.method, ...target, headers, body: content.body } }
}

function entryLabel(index: number, raw: unknown): string {
  const request = isRecord(raw) && isRecord(raw.request) ? raw.request : {}
  const method = typeof request.method === 'string' ? request.method : '?'
  const url = typeof request.url === 'string' ? request.url : '?'
  return `Bundle.entry[${index}] (${method} ${url})`
}

function responseEntry(res: FhirProxyResult): Record<string, unknown> {
  const response: Record<string, unknown> = { status: statusLine(res.status) }
  const location = res.headers.location ?? res.headers['content-location']
  if (location) response.location = location
  if (res.headers.etag) response.etag = res.headers.etag
  const lastModified = new Date(res.headers['last-modified'] ?? '')
  if (!Number.isNaN(lastModified.getTime())) response.lastModified = lastModified.toISOString()
  if (res.status >= 400) {
    response.outcome = toOperationOutcome(res.status, res.body)
    return { response }
  }
  return isRecord(res.body) && typeof res.body.resourceType === 'string' ? { resource: res.body, response } : { response }
}

function refusedEntry(status: number, message: string): Record<string, unknown> {
  return { response: { status: statusLine(status), outcome: operationOutcome(issueCodeForStatus(status), message) } }
}

async function runBatch(entries: unknown[], ctx: BundleContext): Promise<FhirProxyResult> {
  const responses: Record<string, unknown>[] = []
  for (const raw of entries) {
    const parsed = parseEntry(raw, ctx)
    if (!parsed.ok) {
      responses.push(refusedEntry(parsed.status, parsed.message))
      continue
    }
    try {
      responses.push(responseEntry(await ctx.execute(parsed.req)))
    } catch (error) {
      logger.fhir.error('Batch entry failed', { error: error instanceof Error ? error.message : String(error) })
      responses.push(refusedEntry(500, 'The entry could not be processed.'))
    }
  }
  return result(200, { resourceType: 'Bundle', type: 'batch-response', entry: responses })
}

function queryPairs(queryString: string): Array<[string, string]> {
  return [...new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString)]
}

function sameValue(name: string, a: string, b: string): boolean {
  if (a === b) return true
  return (name === 'patient' || name === 'subject') && a.replace(/^Patient\//, '') === b.replace(/^Patient\//, '')
}

/** A transaction cannot be rewritten, so whatever narrowing access control adds must already be in the query. */
export function narrowingAlreadyPresent(original: string, authorized: string): boolean {
  if (original === authorized) return true
  const before = queryPairs(original)
  const remaining = [...before]
  return queryPairs(authorized).every(([name, value]) => {
    const i = remaining.findIndex(([n, v]) => n === name && v === value)
    if (i !== -1) {
      remaining.splice(i, 1)
      return true
    }
    return before.some(([n, v]) => n === name && sameValue(name, v, value))
  })
}

async function transactionRefusal(index: number, raw: unknown, ctx: BundleContext): Promise<{ status: number; message: string } | null> {
  const parsed = parseEntry(raw, ctx)
  if (!parsed.ok) return parsed
  const { req } = parsed
  if (parseFhirPath(req.resourcePath, req.method).operationName === ERASE_OPERATION) {
    return { status: 400, message: `$${ERASE_OPERATION} is answered by the proxy and cannot be part of a transaction.` }
  }
  const decision = await ctx.authorize(req)
  if (!decision.allowed) return { status: decision.status, message: refusalDiagnostics(decision.body) }
  if (!narrowingAlreadyPresent(req.queryString, decision.queryString)) {
    return {
      status: 403,
      message: `This search would have to be narrowed (${decision.queryString}), which a transaction cannot do. Send it with that narrowing, or in a batch.`,
    }
  }
  return null
}

async function runTransaction(bodyText: string, entries: unknown[], ctx: BundleContext): Promise<FhirProxyResult> {
  for (const [index, raw] of entries.entries()) {
    const refusal = await transactionRefusal(index, raw, ctx)
    if (refusal) {
      const label = entryLabel(index, raw)
      logger.fhir.warn('Transaction refused', { entry: label, status: refusal.status, reason: refusal.message })
      return result(refusal.status, operationOutcome(issueCodeForStatus(refusal.status), `${label}: ${refusal.message}`, {
        expression: [`Bundle.entry[${index}]`],
      }))
    }
  }
  return ctx.forwardTransaction(bodyText)
}

export async function handleFhirBundle(bodyText: string, ctx: BundleContext): Promise<FhirProxyResult> {
  let bundle: unknown
  try {
    bundle = JSON.parse(bodyText)
  } catch {
    return result(400, operationOutcome('invalid', 'The request body is not a JSON Bundle.'))
  }
  if (!Value.Check(RequestBundle, bundle)) {
    return result(400, operationOutcome('invalid', 'Only a Bundle of type batch or transaction can be posted to the server base.'))
  }
  const entries = bundle.entry ?? []
  if (entries.length > ctx.maxEntries) {
    return result(413, operationOutcome('too-costly', `The Bundle has ${entries.length} entries; at most ${ctx.maxEntries} are accepted.`))
  }
  return bundle.type === 'batch' ? runBatch(entries, ctx) : runTransaction(bodyText, entries, ctx)
}
