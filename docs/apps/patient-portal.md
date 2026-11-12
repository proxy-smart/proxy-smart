# Patient Portal

> **Note:** This app lives in a separate repository: [max-health-inc/patient-portal](https://github.com/Max-Health-Inc/patient-portal). It deploys independently -- its CI builds static assets and pushes them into the `apps_static` Docker volume on the target server. The backend serves it at `/apps/patient-portal/`.

International Patient Portal built on IPS (International Patient Summary) and IPA (International Patient Access) standards. Patients can view their health summary, medical imaging, and clinical documents through a SMART on FHIR interface.

It launches via SMART App Launch, authenticates the patient, and presents their health data through standardized FHIR profiles rather than a vendor-specific shape, which is what makes the same portal usable against a different server.

```
┌────────────────┐  SMART launch  ┌──────────────┐  FHIR R4   ┌─────────────┐
│ Patient Portal │ ────────────── │  Proxy Smart │ ─────────── │ FHIR Server │
│   (browser)    │  Bearer token  │  /fhir/*     │            │ (IPS, IPA)  │
│                │                │  /dicomweb/* │            │    PACS     │
└────────────────┘                └──────────────┘            └─────────────┘
```

The summary view is built from the patient's IPS document, retrieved through the FHIR `$summary` operation and broken into navigable sections. Individual resources (allergies, conditions, medications, immunizations, observations) are read through IPA-compliant queries, so a server that implements the profile serves this portal without adapter code.

Imaging is a first-class view rather than a link out. Studies are browsed down through series to instances over DICOMweb, and pixel data is rendered in-browser by Cornerstone3D with the usual stack scrolling, zoom, pan, and window/level controls.

## SMART Configuration

| Field | Value |
|---|---|
| Client ID | `patient-portal` |
| Launch Type | Standalone, EHR Launch |
| Scopes | `openid`, `profile`, `patient/Patient.read`, `patient/Condition.read`, `patient/Observation.read`, `patient/AllergyIntolerance.read`, `patient/MedicationRequest.read`, `patient/Immunization.read`, `patient/DocumentReference.read`, `patient/ImagingStudy.read` |
| Redirect URI | `{base}/callback` |

## Development

See the [patient-portal repository](https://github.com/Max-Health-Inc/patient-portal) for development instructions.

| Command | Description |
|---|---|
| `bun run dev` | Start dev server on port 5176 |
| `bun run build` | Production build |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | ESLint |

## Imaging Integration

The Patient Portal uses the [DICOMweb Proxy](/dicomweb-proxy) built into Proxy Smart. When `DICOMWEB_BASE_URL` is configured on the backend, imaging features become available.

### Viewer Controls

| Control | Action |
|---|---|
| Scroll wheel | Navigate through slices in a stack |
| Left drag | Window/Level adjustment |
| Right drag | Zoom |
| Middle drag | Pan |

See [Patient Portal Imaging](/patient-portal-imaging) for detailed imaging architecture.

## IPS Integration

The portal requests the patient's International Patient Summary via the FHIR `$summary` operation:

```
GET /fhir/Patient/{id}/$summary
```

The IPS Bundle is parsed into sections (allergies, medications, conditions, immunizations, etc.) and rendered as navigable cards.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19, TypeScript |
| Build | Vite, Tailwind CSS |
| UI | shadcn/ui (via shared-ui) |
| FHIR | `hl7.fhir.uv.ips-generated` (IPS 2.0.0 types) |
| Imaging | Cornerstone3D, `@babelfhir-ts/dicomweb` |
| Auth | SMART on FHIR (`SmartAppShell`) |
