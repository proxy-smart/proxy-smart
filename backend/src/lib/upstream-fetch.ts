// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import type { MtlsConfigResponseType } from '@/schemas'
import { parseCertificate, serverTls } from './mtls'

/** How the proxy reaches an upstream server: plain fetch, mTLS, or a stand-in under test. */
export type UpstreamFetch = (url: string, init?: RequestInit) => Promise<Response>

export type UpstreamTls = BunFetchRequestInitTLS

/** The client identity and trust anchor the deployment gives the proxy for its own upstreams. */
function deploymentTls(): UpstreamTls | undefined {
  const { cert, key, ca } = config.upstreamTls
  const tls: UpstreamTls = { ...(cert && key ? { cert, key } : {}), ...(ca ? { ca } : {}) }
  return Object.keys(tls).length > 0 ? tls : undefined
}

function coversHost(hostname: string): boolean {
  return config.upstreamTls.hosts.some((host) => host.startsWith('.') ? hostname.endsWith(host) : hostname === host)
}

function servedFrom(url: string, base: string): boolean {
  const root = base.replace(/\/+$/, '')
  return url === root || url.startsWith(`${root}/`) || url.startsWith(`${root}?`)
}

async function registeredServerTls(url: string): Promise<UpstreamTls | undefined> {
  // Imported on use: the server store reaches its upstreams through this module.
  const { fhirServerStore } = await import('./fhir-server-store')
  const server = fhirServerStore.getAllServers().find((s) => servedFrom(url, s.url))
  return server ? serverTls(server.identifier) : undefined
}

/** The deployment's client certificate when it applies to `url`: an https host it covers, with a key to go with it. */
export function deploymentCertificateFor(url: string): string | undefined {
  if (!url.startsWith('https://') || !coversHost(new URL(url).hostname)) return undefined
  const { cert, key } = config.upstreamTls
  return cert && key ? cert : undefined
}

/** Which client certificate upstreamFetch presents to a registered server, so mTLS the deployment provides is visible to admins. */
export async function presentedIdentity(serverId: string): Promise<Pick<MtlsConfigResponseType, 'effective' | 'deploymentCertificate'>> {
  if (await serverTls(serverId)) return { effective: 'server' }
  const { fhirServerStore } = await import('./fhir-server-store')
  const server = fhirServerStore.getServerByName(serverId)
  const cert = server ? deploymentCertificateFor(server.url) : undefined
  if (!cert) return { effective: 'none' }
  try {
    return { effective: 'deployment', deploymentCertificate: parseCertificate(cert) }
  } catch {
    return { effective: 'deployment' }
  }
}

/** TLS for an upstream URL: the server's own mTLS settings first, then the deployment's identity for the hosts it covers. */
export async function upstreamTls(url: string): Promise<UpstreamTls | undefined> {
  if (!url.startsWith('https://')) return undefined
  const own = await registeredServerTls(url)
  if (own) return own
  return coversHost(new URL(url).hostname) ? deploymentTls() : undefined
}

/** Fetch from an upstream FHIR or DICOMweb server, presenting a client certificate where one is configured. */
export const upstreamFetch: UpstreamFetch = async (url, init) => {
  const tls = await upstreamTls(url)
  return fetch(url, tls ? { ...init, tls } : init)
}
