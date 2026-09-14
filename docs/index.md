---
layout: home

hero:
  name: Proxy Smart
  text: Healthcare Interoperability Proxy
  tagline: An authorization layer between SMART apps and FHIR servers that stores no clinical data.
  actions:
    - theme: brand
      text: Get Started
      link: /deployment
    - theme: alt
      text: Architecture
      link: /fhir-proxy

features:
  - title: Stateless by design
    details: Requests pass through to your FHIR servers. Nothing clinical is persisted here, so the proxy is never the system of record.
  - title: SMART App Launch 2.2.0
    details: OAuth 2.0 with PKCE, JWT validation, scope enforcement, and refresh token rotation, verified against Inferno.
  - title: Administered, not configured
    details: Apps, users, servers, scopes, and identity providers are managed through a React admin UI backed by Keycloak.
  - title: Readable by agents
    details: The same admin surface is exposed over MCP at /mcp, so an AI client can operate the platform through the tools the UI uses.
---

# Proxy Smart

Proxy Smart sits between SMART on FHIR applications and the FHIR servers that hold the records. It terminates the OAuth flow, validates and narrows scopes, enforces consent, and forwards what survives. Clinical data is never stored on the way through, which keeps the proxy out of the compliance surface that holding records would create.

Around that core sit a set of SMART apps built on a shared component library, an admin dashboard for the platform itself, and an MCP endpoint that exposes the admin API to AI clients.

## Where it sits

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend Apps                           │
│  Patient Portal │ Consent │ DTR │ Patient Picker │ Admin UI │
│                      SMART DICOM Template                   │
│                                                             │
│  All built with @proxy-smart/shared-ui (SmartAppShell)      │
└──────────────────────────┬──────────────────────────────────┘
                           │ SMART App Launch 2.2.0
┌──────────────────────────▼──────────────────────────────────┐
│                    Proxy Smart Backend                        │
│  Elysia/Bun │ OAuth Proxy │ FHIR Proxy │ MCP Server          │
└──────────┬──────────┬──────────┬────────────────────────────┘
           │          │          │
     ┌─────▼───┐ ┌────▼────┐ ┌──▼───────┐
     │Keycloak │ │FHIR R4  │ │Orthanc   │
     │  (IdP)  │ │Server(s)│ │(DICOMweb)│
     └─────────┘ └─────────┘ └──────────┘
```

Keycloak is the identity provider; the proxy never issues its own tokens. FHIR servers and DICOMweb endpoints are registered at runtime through the admin UI rather than baked into configuration.

## Apps

One app still ships from this repository:

| App | Port | Location | Purpose |
|-----|------|----------|---------|
| [Patient Picker](./apps/patient-picker.md) | 5176 | `packages/patient-picker/` | Patient selection during standalone SMART launch |

The rest live in their own repositories and release on their own cadence:

| App | Port | Repository | Purpose |
|-----|------|------------|---------|
| [Admin UI](./apps/admin-ui.md) | 5173 | [proxy-smart/proxy-smart-admin-ui](https://github.com/proxy-smart/proxy-smart-admin-ui) (private) | Platform administration dashboard |
| [SMART DICOM Template](./apps/smart-dicom-template.md) | 5180 | [proxy-smart/smart-dicom-template](https://github.com/proxy-smart/smart-dicom-template) | Starter kit for imaging algorithm SMART apps, Apache-2.0 and marked as a GitHub template |
| [Patient Portal](./apps/patient-portal.md) | 5173 | [max-health-inc/patient-portal](https://github.com/Max-Health-Inc/patient-portal) | Patient-facing health records, imaging, IPS |
| [Consent Manager](./apps/consent-app.md) | 5174 | [max-health-inc/consent-app](https://github.com/Max-Health-Inc/consent-app) | FHIR Consent resource management |
| [DTR / Prior Auth](./apps/dtr-app.md) | 5175 | [max-health-inc/dtr-app](https://github.com/Max-Health-Inc/dtr-app) | Da Vinci DTR questionnaires and PA workflow |

Each external app builds its static assets in its own CI and pushes them into a shared `apps_static` Docker volume mounted at `/app/backend/public/apps`. The backend serves them from `/apps/{app-name}/`. That decoupling is deliberate: an app can ship without a platform release.

The admin UI is the one exception to that path: this repository's CI checks it out, builds it into `webapp-dist/`, and the backend serves it at `/webapp`. A deployment that skips it still works -- every admin surface is reachable over the API and, since each admin route is derived into an MCP tool, over `/mcp` as well.

## Where to start

If you are deploying the platform, read [Deployment](./deployment.md) and then [Environment Variables](./environment-variables.md). If you are integrating an app against it, [OAuth & Authentication](./oauth-authentication.md) and the [FHIR Proxy](./fhir-proxy.md) describe the two surfaces you will talk to. If you are assessing spec conformance, the [SMART 2.2.0 Checklist](./SMART_2.2.0_CHECKLIST.md) tracks implementation status and [Compliance Reports](./compliance-reports.md) publishes the Inferno results from each environment.

Everything else is in the sidebar.

## External references

- [SMART App Launch Framework](https://hl7.org/fhir/smart-app-launch/)
- [FHIR R4 Specification](https://hl7.org/fhir/R4/)
- [OAuth 2.0 RFC](https://tools.ietf.org/html/rfc6749)
- [OpenID Connect](https://openid.net/connect/)
