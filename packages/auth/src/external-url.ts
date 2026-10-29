// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export type ExternalUrlCheck = { valid: true } | { valid: false; reason: string }

export type HostResolver = (hostname: string) => Promise<string[]>

export interface ExternalUrlPolicy {
  allowInternal?: boolean
  allowedHosts?: readonly string[]
  allowSingleLabelHosts?: boolean
  resolve?: HostResolver
}

const NON_PUBLIC_IPV4: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

const NON_PUBLIC_IPV6: readonly [string, number][] = [
  ['::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]

const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa']

const nonPublic = new BlockList()
for (const [network, prefix] of NON_PUBLIC_IPV4) nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of NON_PUBLIC_IPV6) nonPublic.addSubnet(network, prefix, 'ipv6')

function ipv6Hextets(address: string): number[] | null {
  let text = address.toLowerCase()
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part ? part.split(':').map((h) => parseInt(h, 16)) : [])
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const hextets = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail]
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : null
}

function embeddedIpv4(address: string): string | null {
  const h = ipv6Hextets(address)
  if (!h) return null
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)
  return mapped || nat64 ? [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.') : null
}

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]
  const family = isIP(ip)
  if (family === 4) return !nonPublic.check(ip, 'ipv4')
  if (family !== 6) return false
  const v4 = embeddedIpv4(ip)
  if (v4) return !nonPublic.check(v4, 'ipv4')
  return !nonPublic.check(ip, 'ipv6')
}

const refuse = (reason: string): ExternalUrlCheck => ({ valid: false, reason })

export function checkExternalUrlSyntax(url: string, policy: ExternalUrlPolicy = {}): ExternalUrlCheck {
  if (policy.allowInternal) return { valid: true }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return refuse('Invalid URL format')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse(`Protocol '${parsed.protocol}' is not allowed. Use http: or https:`)
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (policy.allowedHosts?.some((allowed) => allowed.toLowerCase() === host)) return { valid: true }
  if (isIP(host)) {
    return isPublicAddress(host) ? { valid: true } : refuse(`Address '${host}' is not a public address`)
  }
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return refuse(`Hostname '${host}' names a private network`)
  }
  if (!host.includes('.') && !policy.allowSingleLabelHosts) {
    return refuse(`Hostname '${host}' is not a fully qualified domain name`)
  }
  return { valid: true }
}

const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

export async function checkExternalUrl(url: string, policy: ExternalUrlPolicy = {}): Promise<ExternalUrlCheck> {
  const literal = checkExternalUrlSyntax(url, policy)
  if (!literal.valid || policy.allowInternal) return literal

  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host) || policy.allowedHosts?.some((allowed) => allowed.toLowerCase() === host)) return literal

  let addresses: string[]
  try {
    addresses = await (policy.resolve ?? systemResolver)(host)
  } catch (error) {
    return refuse(`Hostname '${host}' could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (addresses.length === 0) return refuse(`Hostname '${host}' does not resolve`)
  const blocked = addresses.find((address) => !isPublicAddress(address))
  return blocked ? refuse(`Hostname '${host}' resolves to the non-public address ${blocked}`) : literal
}

export async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`Response body of ${declared} bytes exceeds ${maxBytes}`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error(`Response body exceeds ${maxBytes} bytes`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
