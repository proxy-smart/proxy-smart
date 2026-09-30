# Dashboard

The admin dashboard is the landing page after logging in. It shows system status and provides navigation to all management sections.

## Sidebar Navigation

| Section | Description |
|---------|-------------|
| SMART Apps | Register and manage OAuth clients |
| Healthcare Users | Manage Keycloak users with FHIR associations |
| FHIR Servers | Configure upstream FHIR endpoints |
| DICOM Servers | Manage PACS/DICOMweb connections |
| Scopes | SMART client scope administration |
| Roles | Realm and client role management |
| Organizations | Multi-tenant organization management |
| Identity Providers | External IdP configuration (SAML, OIDC) |
| User Federation | LDAP and external user stores |
| Launch Contexts | Per-user SMART launch context attributes |
| Consent | Consent enforcement settings |
| Branding | User-Access Brand configuration |
| Monitoring | OAuth, FHIR, and audit metrics |
| MCP Tools | MCP server management and endpoint config |
| App Store | App visibility and catalog management |

## Authentication

The Admin UI authenticates via Keycloak using the `admin-service` client. After login, the frontend stores a session token and uses it for all `/admin/*` API calls.

Unlike the SMART apps (which use `SmartAppShell`), the Admin UI has its own login form and session management.
