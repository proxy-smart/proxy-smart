# FHIR Servers

Configure upstream FHIR servers that the proxy routes requests to. Each registered server gets a proxy path at `/proxy-smart-backend/{server_name}/{fhir_version}/`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fhir-servers/` | List all registered FHIR servers |
| POST | `/admin/fhir-servers/` | Add a new FHIR server |
| GET | `/fhir-servers/:server_id` | Get server details + proxy URLs |
| PUT | `/admin/fhir-servers/:server_id` | Update server name/URL |
| DELETE | `/admin/fhir-servers/:server_id` | Remove a FHIR server |
| POST | `/admin/fhir-servers/:server_id/refresh` | Re-fetch server metadata |
| PATCH | `/admin/fhir-servers/:server_id/strict-capabilities` | Toggle strict CapabilityStatement enforcement |
| PATCH | `/admin/fhir-servers/:server_id/mcp` | Toggle per-server MCP endpoint (deprecated, removed in 0.8.0) |

## mTLS Configuration

For servers that require mutual TLS (client certificates):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/fhir-servers/:server_id/mtls` | Get current mTLS config |
| PUT | `/admin/fhir-servers/:server_id/mtls` | Enable/disable mTLS |
| POST | `/admin/fhir-servers/:server_id/mtls/certificates` | Upload client certificate |

## Adding a Server

Minimum required fields:

- **Name** -- unique identifier used in proxy URLs (e.g., `hapi-fhir`)
- **Base URL** -- upstream FHIR server endpoint (e.g., `http://hapi-fhir:8080/fhir`)
- **FHIR Version** -- `R4`, `R5`, etc.

On creation, the backend fetches the server's `CapabilityStatement` to discover supported resources and operations.

## Proxy URL Structure

Once registered, the server is accessible through the proxy at:

```
/{backend-name}/{server_name}/{fhir_version}/{resource}
```

Example: `/proxy-smart-backend/hapi-fhir/R4/Patient/123`

All requests through the proxy pass through the authorization pipeline (token validation, scope enforcement, consent checks).

## Strict Capabilities

When enabled, the proxy rejects requests for resources or interactions not declared in the server's `CapabilityStatement`. Toggle via `PATCH /admin/fhir-servers/:server_id/strict-capabilities`.

## DICOM Servers

PACS/DICOMweb servers are managed separately:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/dicom-servers/` | List DICOM servers |
| POST | `/admin/dicom-servers/` | Add DICOM server |
| GET | `/admin/dicom-servers/:server_id` | Get details |
| PUT | `/admin/dicom-servers/:server_id` | Update |
| DELETE | `/admin/dicom-servers/:server_id` | Remove |
| GET | `/admin/dicom-servers/:server_id/status` | Probe reachability |
| GET | `/admin/dicom-servers/viewer-app` | Get configured viewer app |
| PUT | `/admin/dicom-servers/viewer-app` | Set viewer app |

## Related

- [FHIR Proxy](../fhir-proxy.md) -- the request pipeline that processes proxied requests
- [SMART Apps](./smart-apps.md) -- apps that access FHIR servers through the proxy
- [Scope Management](./scope-management.md) -- scopes enforced at the proxy layer
- [Monitoring](./monitoring.md) -- server availability, response times, and the audit trail
