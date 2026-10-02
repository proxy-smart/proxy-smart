// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { upstreamAuthHeader } from '@/lib/http-auth'
import { getDefaultDicomServer } from '@/lib/runtime-config'
import type { DicomServerConfigType, PacsStatusType } from '@/schemas'

const PROBE_TIMEOUT_MS = 5_000

export function pacsAuthHeader(server: DicomServerConfigType | null | undefined): string | null {
  return server ? upstreamAuthHeader(server) : config.dicomweb.upstreamAuth
}

/** Public DICOMweb base a client uses to reach one DICOM server through the proxy */
export function dicomwebProxyBase(serverId: string): string {
  return `${config.baseUrl}/dicomweb/servers/${encodeURIComponent(serverId)}`
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : ''
}

/** Node reports ECONNREFUSED / "fetch failed"; Bun reports code ConnectionRefused */
export function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : ''
  return ['ECONNREFUSED', 'ConnectionRefused'].includes(errorCode(err)) || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
}

/** Probe failure reason without the raw error, which can carry upstream host names */
function unreachableReason(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return `No response within ${PROBE_TIMEOUT_MS / 1000} s`
  if (isConnectionRefused(err)) return 'Connection refused — is the PACS server running?'
  const code = errorCode(err)
  const msg = err instanceof Error ? err.message : ''
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || msg.includes('ENOTFOUND')) return 'PACS host name does not resolve'
  if (/certificate|CERT_|SSL|TLS/i.test(`${code} ${msg}`)) return 'TLS handshake with the PACS failed'
  return 'Upstream request failed'
}

/** Lightweight QIDO-RS probe: is a PACS configured and can the proxy reach it? */
export async function probePacs(explicitServer?: DicomServerConfigType | null): Promise<PacsStatusType> {
  const server = explicitServer ?? getDefaultDicomServer()
  const base = server?.baseUrl ?? (config.dicomweb.enabled ? config.dicomweb.baseUrl : undefined)
  if (!base) {
    return { configured: false, reachable: null, message: 'DICOMweb is not configured. No PACS connection available.' }
  }

  const headers = new Headers()
  const auth = pacsAuthHeader(server)
  if (auth) headers.set('authorization', auth)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const resp = await fetch(`${base.replace(/\/+$/, '')}/studies?limit=1`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    return {
      configured: true,
      // 401 means the PACS is up but rejects the configured credentials
      reachable: resp.ok || resp.status === 401,
      message: resp.ok ? 'PACS is available' : `PACS responded with HTTP ${resp.status}`,
    }
  } catch (err) {
    logger.fhir.warn('PACS health probe failed', { serverId: server?.id, base, error: err instanceof Error ? err.message : String(err) })
    return { configured: true, reachable: false, message: `Cannot reach PACS: ${unreachableReason(err)}` }
  } finally {
    clearTimeout(timeout)
  }
}
