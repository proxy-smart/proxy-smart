# DICOMweb Proxy

Proxy Smart includes a built-in DICOMweb proxy at `/dicomweb/*` that forwards QIDO-RS and WADO-RS requests to an upstream PACS (e.g. Orthanc) while enforcing SMART on FHIR authentication.

## Overview

The DICOMweb proxy enables SMART-authorized applications to query and retrieve medical imaging data without direct access to the PACS. Every request is authenticated via Bearer token, and all DICOM UIDs are validated before forwarding.

```
┌─────────────┐     Bearer token     ┌──────────────┐    upstream auth    ┌──────────┐
│  SMART App  │ ──────────────────── │  Proxy Smart │ ─────────────────── │   PACS   │
│  (browser)  │   GET /dicomweb/...  │  /dicomweb/* │  GET /dicom-web/.. │ (Orthanc)│
└─────────────┘                      └──────────────┘                     └──────────┘
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `DICOMWEB_BASE_URL` | -- | DICOMweb root URL (e.g. `http://orthanc:8042/dicom-web`). Enables the proxy when set. |
| `DICOMWEB_WADO_ROOT` | same as base | Override the WADO-RS root URL |
| `DICOMWEB_QIDO_ROOT` | same as base | Override the QIDO-RS root URL |
| `DICOMWEB_UPSTREAM_AUTH` | -- | Authorization header for the upstream PACS (e.g. `Basic dXNlcjpwYXNz`) |
| `DICOMWEB_TIMEOUT_MS` | `30000` | Upstream request timeout in milliseconds |

## Endpoints

All endpoints require a valid SMART on FHIR Bearer token. DICOM UIDs are validated against the pattern `^[0-9.]+$`.

### QIDO-RS (Query)

| Method | Path | Description |
|---|---|---|
| GET | `/dicomweb/studies` | Search studies by PatientName, PatientID, StudyDate, etc. |
| GET | `/dicomweb/studies/{studyUID}/series` | Search series within a study |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances` | Search instances within a series |

Query parameters are passed through to the upstream PACS. Common QIDO-RS query keys include `PatientName`, `PatientID`, `StudyDate`, `Modality`, and `limit`/`offset`.

### WADO-RS (Retrieve)

| Method | Path | Description |
|---|---|---|
| GET | `/dicomweb/studies/{studyUID}` | Retrieve all instances of a study (multipart DICOM) |
| GET | `/dicomweb/studies/{studyUID}/metadata` | Study metadata (DICOM JSON) |
| GET | `/dicomweb/studies/{studyUID}/rendered` | Rendered (JPEG/PNG) study image |
| GET | `/dicomweb/studies/{studyUID}/thumbnail` | Study thumbnail |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}` | Retrieve a series (multipart DICOM) |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/metadata` | Series metadata (DICOM JSON) |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/rendered` | Rendered series image |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/thumbnail` | Series thumbnail |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}` | Retrieve a single instance |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/metadata` | Instance metadata |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/rendered` | Rendered instance |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/thumbnail` | Instance thumbnail |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/frames/{frame}` | Retrieve specific frame(s) |
| GET | `/dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{sopUID}/bulkdata/*` | Retrieve bulkdata by tag |

### Multiple DICOM servers

Every DICOM server configured in the admin UI is reachable under its own base, `/dicomweb/servers/{serverId}/...`, with the same QIDO-RS, WADO-RS and STOW-RS paths as above. The unscoped `/dicomweb/*` routes go to the default server.

Clients discover the servers without a token, the same way `/fhir-servers` works for FHIR:

| Method | Path | Description |
|---|---|---|
| GET | `/dicom-servers` | `{ totalServers, servers: [{ id, name, isDefault, dicomweb }] }`, where `dicomweb` is the proxied base for that server |
| GET | `/dicom-servers/{serverId}/status` | `{ id, reachable, message }`; `reachable` is `null` when no probe could run |

These routes are read-only and never return the upstream PACS address or its credentials. Managing servers stays under `/admin/dicom-servers`.

### Upload quotas

`DICOM_STORAGE_QUOTAS` limits how much PACS storage a caller's STOW-RS uploads may fill, per membership tier (for example `free=500MB,lite=10GB,pro=100GB`). The tier is read from the access-token claim named by `MEMBERSHIP_TIER_CLAIM` (default `membership_tier`). The proxy provisions what puts it there: a `membership-tier-import` mapper on each identity provider copies the upstream `membership_tier` claim onto the user, and a `membership-tier-mapper` on the default `roles` client scope emits it in access tokens.

After a store is authorized, the proxy adds up the PACS bytes of the studies named by the ImagingStudies the caller added (the ones it signed an added-by Provenance for), measured fresh rather than from the usage cache. An upload with a `Content-Length` that would pass the limit is refused before anything reaches the PACS; a chunked upload is metered and cut off once it passes. Both are answered `413`:

```json
{ "error": "storage_quota_exceeded", "message": "...", "plan": "free", "usedBytes": 520093696, "limitBytes": 524288000, "incomingBytes": 8388608 }
```

`plan`, `usedBytes`, `limitBytes` and `incomingBytes` match the storage refusal the DICOM viewer already renders.

Uploads stay unlimited for a token without the tier claim, a tier with no entry, a system-scoped token, and wherever usage cannot be measured: a PACS other than Orthanc, a study size the PACS will not report, or a failed lookup. Those cases are logged as warnings and the upload goes through.

### Response Handling

- **DICOM JSON** responses (`metadata`, QIDO-RS) are returned as `application/dicom+json`
- **Binary** responses (WADO-RS retrieve, frames, bulkdata) stream the upstream response directly, preserving `Content-Type` and `Transfer-Encoding` headers
- **Rendered** responses return `image/jpeg` or `image/png`

## Development Setup

The development Docker Compose includes an Orthanc PACS:

```yaml
# docker-compose.development.yml
orthanc:
  image: jodogne/orthanc-plugins:1.12.8
  ports:
    - "8042:8042"   # DICOMweb + HTTP UI
    - "4242:4242"   # DICOM DIMSE
  environment:
    ORTHANC__DICOM_WEB__ENABLE: "true"
    ORTHANC__DICOM_WEB__ROOT: "/dicom-web/"
```

The backend connects via `DICOMWEB_BASE_URL=http://orthanc:8042/dicom-web`.

Upload test DICOM files via the Orthanc web UI at `http://localhost:8042` or using `storescu`:

```bash
storescu localhost 4242 path/to/dicom/files/
```

## Authentication Flow

1. Client sends `GET /dicomweb/studies` with `Authorization: Bearer <smart_token>`
2. Proxy validates the SMART token (JWT signature, expiry, scopes)
3. Proxy builds the upstream PACS URL and forwards the request
4. If `DICOMWEB_UPSTREAM_AUTH` is configured, it's added as the `Authorization` header to the upstream request
5. The PACS response is streamed back to the client

## Production Deployment

In production, point `DICOMWEB_BASE_URL` to your PACS DICOMweb endpoint. The proxy supports any DICOMweb-compliant server (Orthanc, DCM4CHEE, Google Cloud Healthcare API, Azure DICOM, etc.).

```env
DICOMWEB_BASE_URL=https://pacs.hospital.org/dicom-web
DICOMWEB_UPSTREAM_AUTH=Bearer <service_token>
DICOMWEB_TIMEOUT_MS=60000
```
