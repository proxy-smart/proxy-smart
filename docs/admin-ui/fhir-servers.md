# FHIR Servers

Configure upstream FHIR servers that the proxy routes requests to. Each registered server gets a proxy path at `/proxy-smart-backend/{server_name}/{fhir_version}/`.

## API Endpoints

Public discovery, readable without an admin token:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fhir-servers/` | List all registered FHIR servers |
| GET | `/fhir-servers/:server_id` | Get server details + proxy URLs |

Admin routes, for admins and auditors (`PATCH /admin/fhir-servers/:server_id/mcp` is deprecated and removed in 0.9.0):

<!-- generated:admin-routes /admin/fhir-servers -->
| Method | Path | Summary |
|---|---|---|
| `GET` | `/admin/fhir-servers/` | List FHIR Servers (admin) |
| `POST` | `/admin/fhir-servers/` | Add New FHIR Server |
| `GET` | `/admin/fhir-servers/:server_id` | Get FHIR Server (admin) |
| `PUT` | `/admin/fhir-servers/:server_id` | Update FHIR Server |
| `DELETE` | `/admin/fhir-servers/:server_id` | Delete FHIR Server |
| `PATCH` | `/admin/fhir-servers/:server_id/mcp` | Toggle MCP Endpoint (deprecated) |
| `GET` | `/admin/fhir-servers/:server_id/mtls` | Get mTLS Configuration |
| `PUT` | `/admin/fhir-servers/:server_id/mtls` | Update mTLS Configuration |
| `POST` | `/admin/fhir-servers/:server_id/mtls/certificates` | Upload Certificate |
| `POST` | `/admin/fhir-servers/:server_id/refresh` | Refresh FHIR Server Metadata |
| `PATCH` | `/admin/fhir-servers/:server_id/strict-capabilities` | Toggle Strict Capability Enforcement |
<!-- /generated:admin-routes -->

## mTLS Configuration

For servers that require mutual TLS (client certificates), the `/mtls` routes above read the configuration, enable or disable it, and upload the client certificate.

## Adding a Server

Fields:

- **Base URL** (required) -- upstream FHIR server endpoint (e.g., `http://hapi-fhir:8080/fhir`)
- **Name** (optional) -- what clients are told the server is called

On creation, the backend fetches the server's `CapabilityStatement` to discover its FHIR version and supported resources and operations. The `server_name` in proxy URLs is derived from the software name the server reports (e.g., `hapi-fhir-server`) and does not change when you rename the server. If an upstream from `FHIR_SERVER_BASE` is unreachable when the proxy starts, the server is listed under a name taken from its host until it answers; the first request for its usual `server_name` after that re-reads its metadata and puts it back under that name. A server whose settings were saved keeps the name they were saved under throughout.

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
