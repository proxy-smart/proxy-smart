// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { TEST_REALM } from './test-env'

export type FetchInput = string | URL | Request
export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>
/** A route answers the URLs it knows and returns undefined for the rest. */
export type FetchRoute = (url: string, init?: RequestInit) => Response | undefined

export function requestUrl(input: FetchInput): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** A typed `fetch` stand-in, assignable wherever Bun's `typeof fetch` is expected. */
export function fakeFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(
    async (input: FetchInput, init?: RequestInit) => handler(requestUrl(input), init),
    { preconnect: () => {} },
  )
}

export function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })
}

export interface RecordedFetch {
  url: string
  init?: RequestInit
}

/** Points globalThis.fetch at a stub answering every call with `respond()`; restoring it is the caller's job. */
export function stubGlobalFetch(respond: () => Response): RecordedFetch[] {
  const calls: RecordedFetch[] = []
  globalThis.fetch = fakeFetch((url, init) => {
    calls.push({ url, init })
    return respond()
  })
  return calls
}

export interface CapturedRequest {
  url: string
  authorization: string | null
  params: URLSearchParams
}

export function captureRequest(url: string, init?: RequestInit): CapturedRequest {
  return {
    url,
    authorization: new Headers(init?.headers).get('authorization'),
    params: new URLSearchParams(init?.body?.toString() ?? ''),
  }
}

export function isRealmProbe(url: string): boolean {
  return url.includes(`/realms/${TEST_REALM}`) && !url.includes('/protocol/')
}

/** Keycloak that answers its reachability probe, then `route`, and 404s everything else. */
export function keycloakFetch(route: FetchRoute = () => undefined): typeof fetch {
  return fakeFetch((url, init) => {
    if (isRealmProbe(url)) return new Response('{}', { status: 200 })
    return route(url, init) ?? new Response('Not Found', { status: 404 })
  })
}
