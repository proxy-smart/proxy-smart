# FHIR Servers

Configure upstream FHIR servers that the proxy routes requests to. Each registered server gets a proxy path at `/proxy-smart-backend/{server_name}/{fhir_version}/`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fhir-servers/` | List all registered FHIR servers |
| POST | `/admin/fhir-servers/` | Add a new FHIR server |
| GET | `/fhir-servers/:server_id` | Get server details + proxy URLs |
| GET | `/admin/fhir-servers/` | List servers with their upstream URL and software (admins and auditors) |
| GET | `/admin/fhir-servers/:server_id` | One server with its upstream URL and software (admins and auditors) |
| PUT | `/admin/fhir-servers/:server_id` | Update server name/URL |
| DELETE | `/admin/fhir-servers/:server_id` | Remove a FHIR server |
| POST | `/admin/fhir-servers/:server_id/refresh` | Re-fetch server metadata |
| PATCH | `/admin/fhir-servers/:server_id/strict-capabilities` | Toggle strict CapabilityStatement enforcement |
| PATCH | `/admin/fhir-servers/:server_id/mcp` | Toggle per-server MCP endpoint (deprecated, removed in 0.9.0) |

## mTLS Configuration

For servers that require mutual TLS (client certificates):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/fhir-servers/:server_id/mtls` | Get current mTLS config |
| PUT | `/admin/fhir-servers/:server_id/mtls` | Enable/disable mTLS |
| POST | `/admin/fhir-servers/:server_id/mtls/certificates` | Upload client certificate |

## Adding a Server

Fields:

- **Base URL** (required) -- upstream FHIR server endpoint (e.g., `http://hapi-fhir:8080/fhir`)
- **Name** (optional) -- what clients are told the server is called

On creation, the backend fetches the server's `CapabilityStatement` to discover its FHIR version and supported resources and operations. The `server_name` in proxy URLs is derived from the software name the server reports (e.g., `hapi-fhir-server`) and does not change when you rename the server.

## Public Name

The proxy serves each server's `CapabilityStatement` with `software.name` set to the deployment's brand name (`BRAND_NAME`) and `implementation.description` set to the server's public name, which is the name an admin gave it or `FHIR Server` without one. The same public name is used in the user-access brand bundle (`/branding.json`) and on the instance page. A metadata refresh keeps the name an admin chose.

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
| GET | `/admin/dicom-servers/viewer-app` | Get configured viewer app (any enabled registered SMART app, or one bundled with the proxy) |
| PUT | `/admin/dicom-servers/viewer-app` | Set viewer app |

## Related

- [FHIR Proxy](../fhir-proxy.md) -- the request pipeline that processes proxied requests
- [SMART Apps](./smart-apps.md) -- apps that access FHIR servers through the proxy
- [Scope Management](./scope-management.md) -- scopes enforced at the proxy layer
- [Monitoring](./monitoring.md) -- server availability, response times, and the audit trail
