// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as forge from 'node-forge'
import * as mtls from '../src/lib/mtls'
import { fhirServerStore } from '../src/lib/fhir-server-store'
import { upstreamFetch, upstreamTls } from '../src/lib/upstream-fetch'

interface Issued { cert: string; key: string }

function issue(subject: string, issuer: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null, extensions: object[]): Issued & { forgeCert: forge.pki.Certificate; forgeKey: forge.pki.rsa.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8))
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  cert.setSubject([{ name: 'commonName', value: subject }])
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: 'commonName', value: subject }])
  cert.setExtensions(extensions)
  cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey), forgeCert: cert, forgeKey: keys.privateKey }
}

const ca = issue('test-ca', null, [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }])
const signer = { cert: ca.forgeCert, key: ca.forgeKey }
const server = issue('localhost', signer, [{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }])
const client = issue('backend', signer, [{ name: 'extKeyUsage', clientAuth: true }])

const BINARY = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
const ENV = ['UPSTREAM_MTLS_CERT_PEM', 'UPSTREAM_MTLS_KEY_PEM', 'UPSTREAM_MTLS_CA_PEM', 'UPSTREAM_MTLS_CERT_FILE', 'UPSTREAM_MTLS_KEY_FILE', 'UPSTREAM_MTLS_CA_FILE', 'UPSTREAM_MTLS_HOSTS'] as const

let upstream: ReturnType<typeof Bun.serve>
let base: string
let dir: string

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: 'localhost',
    tls: { cert: server.cert, key: server.key, ca: ca.cert, requestCert: true, rejectUnauthorized: true },
    fetch: () => new Response(BINARY, { headers: { 'content-type': 'application/dicom' } }),
  })
  base = `https://localhost:${upstream.port}`
  dir = mkdtempSync(join(tmpdir(), 'upstream-tls-'))
})

afterAll(async () => {
  await upstream.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  for (const name of ENV) delete process.env[name]
})

function deploymentIdentity(hosts = 'localhost'): void {
  process.env.UPSTREAM_MTLS_CERT_PEM = client.cert
  process.env.UPSTREAM_MTLS_KEY_PEM = client.key
  process.env.UPSTREAM_MTLS_CA_PEM = ca.cert
  process.env.UPSTREAM_MTLS_HOSTS = hosts
}

describe('upstreamFetch', () => {
  it('presents the deployment identity to a covered host, and binary bodies arrive intact', async () => {
    deploymentIdentity()
    const res = await upstreamFetch(`${base}/dicom-web/studies/1/instances/2`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BINARY)
  })

  it('reads mounted PEM files as well', async () => {
    const paths = { cert: join(dir, 'client.pem'), key: join(dir, 'client.key'), ca: join(dir, 'ca.pem') }
    writeFileSync(paths.cert, client.cert)
    writeFileSync(paths.key, client.key)
    writeFileSync(paths.ca, ca.cert)
    process.env.UPSTREAM_MTLS_CERT_FILE = paths.cert
    process.env.UPSTREAM_MTLS_KEY_FILE = paths.key
    process.env.UPSTREAM_MTLS_CA_FILE = paths.ca
    process.env.UPSTREAM_MTLS_HOSTS = '.localhost,localhost'
    expect((await upstreamFetch(`${base}/fhir/metadata`)).status).toBe(200)
  })

  it('gives the identity to no host the deployment did not name', async () => {
    deploymentIdentity('hapi-fhir.proxy-smart.internal')
    expect(await upstreamTls(`${base}/fhir/metadata`)).toBeUndefined()
    await expect(upstreamFetch(`${base}/fhir/metadata`)).rejects.toThrow()
  })

  it('never attaches TLS settings to plain HTTP', async () => {
    deploymentIdentity()
    expect(await upstreamTls('http://localhost:8080/fhir/metadata')).toBeUndefined()
  })

  it('prefers the client certificate an admin set for the registered server', async () => {
    deploymentIdentity()
    const own = { cert: 'own-cert', key: 'own-key' }
    const servers = spyOn(fhirServerStore, 'getAllServers').mockReturnValue([{
      name: 'hapi', url: `${base}/fhir/`, identifier: 'hapi', metadata: { fhirVersion: '4.0.1', serverName: 'hapi', supported: true }, lastUpdated: 0,
    }])
    const serverTls = spyOn(mtls, 'serverTls').mockImplementation(async (serverId) => serverId === 'hapi' ? own : undefined)
    expect(await upstreamTls(`${base}/fhir/Patient?name=x`)).toEqual(own)
    expect(await upstreamTls(`${base}/fhir2/Patient`)).toEqual({ cert: client.cert, key: client.key, ca: ca.cert })
    servers.mockRestore()
    serverTls.mockRestore()
  })
})
