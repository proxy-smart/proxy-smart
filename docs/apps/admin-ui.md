# Admin UI

React-based administration dashboard for managing the Proxy Smart platform. Provides full control over SMART apps, users, FHIR servers, scopes, identity providers, consent, and monitoring.

It is a single-page application against the backend's admin REST API, served as static files from the backend at `/webapp/` behind admin-level authentication.

```
┌────────────┐   Admin API   ┌──────────────┐
│  Admin UI  │ ─────────────►│  Backend     │
│  (React)   │  /admin/*     │  (Elysia)    │
└────────────┘               └──────────────┘
```

## What it administers

Most of what the platform knows is configured here at runtime rather than through environment variables, which is why a new FHIR server or SMART client needs no redeploy.

| Area | Manages | Detail |
|---|---|---|
| SMART Apps | Client registration, redirect URIs, launch types, Dynamic Client Registration settings | [docs](../admin-ui/smart-apps.md) |
| Scopes | FHIR scope definitions, assignment, and reusable scope templates | [docs](../admin-ui/scope-management.md) |
| Healthcare Users | Users and the FHIR resources they resolve to (`fhirUser`) | [docs](../admin-ui/user-management.md) |
| Identity Providers | External SAML and OIDC identity providers | [docs](../admin-ui/identity-providers.md) |
| User Federation | LDAP and other external user stores | [docs](../admin-ui/user-federation.md) |
| Organizations | Multi-tenant organizations and per-organization branding | [docs](../admin-ui/organizations.md) |
| FHIR Servers | Server endpoints, capability probing, and health | [docs](../admin-ui/fhir-servers.md) |
| DICOM Servers | Orthanc and DICOMweb PACS connections | [docs](../dicomweb-proxy.md) |
| Launch Contexts | Per-user patient, encounter, and tenant context | [docs](../admin-ui/launch-context.md) |
| Monitoring | OAuth metrics, FHIR availability, consent decisions, auth attempts, and the admin audit trail | [docs](../admin-ui/monitoring.md) |

Consent enforcement and webhooks, Identity Assurance Level thresholds, backend service credentials, the MCP endpoint, and Keycloak realm settings are configured here too, and have no separate page yet.

## Development

```bash
cd frontend/ui
bun run dev
# -> http://localhost:5173/
```

| Command | Description |
|---|---|
| `bun run dev` | Start Vite dev server (default port 5173) |
| `bun run build` | Production build |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | ESLint |
| `bun run test` | Vitest unit tests |
| `bun run generate` | Regenerate API client from backend OpenAPI spec |

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19, TypeScript |
| Build | Vite, Tailwind CSS |
| UI | shadcn/ui (via `@proxy-smart/shared-ui`), Radix primitives |
| Routing | Component-based navigation (no router -- single admin SPA) |
| State | React hooks, service layer with fetch |
| Theme | Dark/light/system via ThemeProvider |
| Modals | `ModalStackProvider` from shared-ui |

## Architecture

The Admin UI does **not** use `SmartAppShell` -- it has its own `LoginForm` + `AdminApp` shell since it authenticates differently (admin credentials, not SMART launch).

```
App.tsx
  └─ ThemeProvider
      └─ ModalStackProvider
          └─ AdminApp (login gate + navigation + content)
              ├─ LoginForm (when unauthenticated)
              └─ Navigation + Feature Components (when authenticated)
```

Per-feature documentation starts at the [Dashboard](../admin-ui/dashboard.md); the table above links each area directly.
