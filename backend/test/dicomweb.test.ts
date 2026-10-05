import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { dicomwebRoutes } from '../src/routes/dicomweb'

/**
 * DICOMweb proxy route tests.
 *
 * We mock `globalThis.fetch` to simulate upstream PACS responses and
 * `validateToken` via module-level mocking to bypass real JWT validation.
 */

const ORIGINAL_FETCH = globalThis.fetch

// Helper: create a mock fetch that resolves with a given response
function mockFetchWith(body: unknown, init?: ResponseInit) {
  const mockFn = Object.assign(
    async (_url: string | URL | Request, _opts?: RequestInit) =>
      new Response(
        typeof body === 'string' ? body : JSON.stringify(body),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          ...init,
        },
      ),
    { preconnect: () => {} },
  ) as typeof fetch
  globalThis.fetch = mockFn
  return mockFn
}

// Stub env vars for DICOMweb config
const _ORIGINAL_ENV = { ...process.env }

function setDicomwebEnv(baseUrl = 'http://orthanc:8042/dicom-web') {
  process.env.DICOMWEB_BASE_URL = baseUrl
}

function clearDicomwebEnv() {
  delete process.env.DICOMWEB_BASE_URL
  delete process.env.DICOMWEB_UPSTREAM_AUTH
  delete process.env.DICOMWEB_WADO_ROOT
  delete process.env.DICOMWEB_QIDO_ROOT
  delete process.env.DICOMWEB_TIMEOUT_MS
}

// ---- Token validation mock ----
// We mock the auth module so validateToken resolves without real JWT/Keycloak
const mockValidateToken = mock(async (_token: string) => ({
  sub: 'user-1',
  azp: 'patient-portal',
  iss: 'http://localhost:8080/realms/proxy-smart',
}))

// Use Bun's module mock
mock.module('../src/lib/auth', () => ({
  validateToken: mockValidateToken,
}))

// The route tests cover proxying; FHIR-backed authorization has its own tests (dicomweb-access).
// Study 1.2.3.4 is the one the caller can read.
const READABLE_STUDY = '1.2.3.4'
mock.module('../src/routes/dicomweb-access-deps', () => ({
  dicomAccessDeps: {
    mode: () => process.env.ROLE_BASED_FILTERING_MODE ?? 'audit-only',
    searchImagingStudies: async (_auth: string, query: string) => {
      const uid = new URLSearchParams(query).get('identifier')?.replace('urn:oid:', '')
      return { status: 200, studyUids: uid ? (uid === READABLE_STUDY ? [uid] : []) : [READABLE_STUDY] }
    },
    callerIdentity: async () => ({ patientId: 'own-patient', practitioner: false }),
  },
}))

describe('DICOMweb proxy routes', () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    setDicomwebEnv()
    mockValidateToken.mockClear()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    clearDicomwebEnv()
  })

  // ==================== Auth ====================

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies'),
    )
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toHaveProperty('error', 'Authentication required')
  })

  it('returns 501 when DICOMWEB_BASE_URL is not configured', async () => {
    clearDicomwebEnv()
    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(501)
    const json = await res.json()
    expect(json.error).toContain('not configured')
  })

  // ==================== QIDO-RS ====================

  it('GET /dicomweb/studies proxies to upstream PACS', async () => {
    const studies = [{ '0020000D': { Value: ['1.2.3.4'], vr: 'UI' } }]
    const _mockFn = mockFetchWith(studies)

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies?PatientName=Smith', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(studies)

    expect(mockValidateToken).toHaveBeenCalledTimes(1)
  })

  it('refuses a study the caller cannot read through FHIR when filtering is enforced', async () => {
    mockFetchWith([{ '0020000E': { Value: ['1.2.3.4.5'], vr: 'UI' } }])
    process.env.ROLE_BASED_FILTERING_MODE = 'enforce'
    try {
      const res = await dicomwebRoutes.handle(
        new Request('http://localhost/dicomweb/studies/9.9.9.9/series', {
          headers: { authorization: 'Bearer valid-token' },
        }),
      )
      expect(res.status).toBe(403)
    } finally {
      delete process.env.ROLE_BASED_FILTERING_MODE
    }
  })

  it('GET /dicomweb/studies/:studyUID/series proxies correctly', async () => {
    const series = [{ '0020000E': { Value: ['1.2.3.4.5'], vr: 'UI' } }]
    mockFetchWith(series)

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(series)
  })

  it('GET /dicomweb/studies/:studyUID/series/:seriesUID/instances proxies correctly', async () => {
    const instances = [{ '00080018': { Value: ['1.2.3.4.5.6'], vr: 'UI' } }]
    mockFetchWith(instances)

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(instances)
  })

  // ==================== WADO-RS Metadata ====================

  it('GET /dicomweb/studies/:studyUID/metadata returns metadata JSON', async () => {
    const metadata = [{ '00080060': { Value: ['CT'], vr: 'CS' } }]
    mockFetchWith(metadata)

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/metadata', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(metadata)
  })

  it('GET /dicomweb/studies/:studyUID/series/:seriesUID/metadata returns metadata JSON', async () => {
    const metadata = [{ '00080060': { Value: ['MR'], vr: 'CS' } }]
    mockFetchWith(metadata)

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/metadata', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(metadata)
  })

  // ==================== WADO-RS Binary ====================

  it('GET /dicomweb/studies/:studyUID/rendered returns binary image', async () => {
    const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])
    globalThis.fetch = Object.assign(
      async () =>
        new Response(jpegBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/rendered', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('GET /dicomweb/studies/:studyUID/thumbnail returns thumbnail image', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47])
    globalThis.fetch = Object.assign(
      async () =>
        new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/thumbnail', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  // ==================== Instance + Frame level ====================

  it('GET /dicomweb/studies/:studyUID/series/:seriesUID/instances/:sopUID proxies correctly', async () => {
    const dicomBytes = new Uint8Array([0x44, 0x49, 0x43, 0x4D]) // "DICM"
    globalThis.fetch = Object.assign(
      async () =>
        new Response(dicomBytes, {
          status: 200,
          headers: { 'content-type': 'application/dicom' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances/1.2.3.4.5.6', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
  })

  it('GET /dicomweb/studies/.../frames/:frame proxies correctly', async () => {
    const frameData = new Uint8Array([0x00, 0x01, 0x02])
    globalThis.fetch = Object.assign(
      async () =>
        new Response(frameData, {
          status: 200,
          headers: { 'content-type': 'multipart/related' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances/1.2.3.4.5.6/frames/1', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(200)
  })

  // ==================== UID validation ====================

  it('rejects invalid DICOM UIDs in path params', async () => {
    mockFetchWith([])

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/not-a-valid-uid/series', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    // Elysia validates params before handler — should fail validation
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  // ==================== Upstream auth header ====================

  it('attaches upstream auth when DICOMWEB_UPSTREAM_AUTH is set', async () => {
    process.env.DICOMWEB_UPSTREAM_AUTH = 'Basic dGVzdDp0ZXN0'
    let capturedHeaders: Headers | null = null

    globalThis.fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      { preconnect: () => {} },
    ) as typeof fetch

    await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!.get('authorization')).toBe('Basic dGVzdDp0ZXN0')
  })

  // ==================== Error handling ====================

  it('returns 502 when upstream PACS is unreachable', async () => {
    globalThis.fetch = Object.assign(
      async () => { throw new Error('ECONNREFUSED') },
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toContain('PACS server is not reachable')
    expect(json.message).toContain('not responding')
  })

  // ==================== Series-level routes ====================

  it('GET /dicomweb/studies/:studyUID/series/:seriesUID/rendered proxies correctly', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(new Uint8Array([0xFF]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/rendered', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('GET /dicomweb/studies/:studyUID/series/:seriesUID/thumbnail proxies correctly', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(new Uint8Array([0x89]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/thumbnail', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(200)
  })

  // ==================== Instance metadata + rendered + thumbnail ====================

  it('GET /dicomweb/.../instances/:sopUID/metadata proxies correctly', async () => {
    mockFetchWith([{ '00080060': { Value: ['CT'], vr: 'CS' } }])

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances/1.2.3.4.5.6/metadata', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('GET /dicomweb/.../instances/:sopUID/rendered proxies correctly', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(new Uint8Array([0xFF, 0xD8]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances/1.2.3.4.5.6/rendered', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('GET /dicomweb/.../instances/:sopUID/thumbnail proxies correctly', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(new Uint8Array([0x89, 0x50]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      { preconnect: () => {} },
    ) as typeof fetch

    const res = await dicomwebRoutes.handle(
      new Request('http://localhost/dicomweb/studies/1.2.3.4/series/1.2.3.4.5/instances/1.2.3.4.5.6/thumbnail', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )
    expect(res.status).toBe(200)
  })
})
