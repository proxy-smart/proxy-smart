# SMART DICOM Template

Starter kit for building SMART on FHIR imaging algorithm apps. Clone this template, implement your algorithm in `src/algorithm.ts`, and deploy as a registered SMART app on Proxy Smart.

Everything a SMART-launched imaging app needs is already wired: authentication, DICOMweb study retrieval, Cornerstone3D image loading, and the UI that drives them. What is left is one function.

```
┌────────────────────┐  SMART launch  ┌──────────────┐  DICOMweb  ┌──────┐
│ DICOM Algorithm App│ ────────────── │  Proxy Smart │ ─────────── │ PACS │
│     (browser)      │  Bearer token  │  /dicomweb/* │            │      │
└────────────────────┘                └──────────────┘            └──────┘
         │
         ▼
   ┌─────────────┐
   │ algorithm.ts │  Your imaging algorithm
   └─────────────┘
```

`runAlgorithm()` receives a study's image IDs and its FHIR metadata and returns a finding. The template supplies the rest: `SmartAppShell` runs the OAuth 2.0 and PKCE launch, `@babelfhir-ts/dicomweb` retrieves studies, series, and instances, and Cornerstone3D loads WADO-RS pixel data with the access token injected into each request. The study selector, run control, and result card are already built against that interface, so a returned result renders without any UI work.

## Quick Start

```bash
# 1. Copy the template
cp -r frontend/smart-dicom-template frontend/my-algorithm

# 2. Update package.json name, port, and clientId in src/config.ts
# 3. Implement your algorithm in src/algorithm.ts
# 4. Register as a SMART app in Proxy Smart admin

cd frontend/my-algorithm
bun install
bun run dev
# -> http://localhost:5180/apps/smart-dicom-template/
```

## Algorithm Interface

Your algorithm lives in `src/algorithm.ts`. Implement the `runAlgorithm` function:

```typescript
import type { ImagingStudyUvIps as ImagingStudy } from "@max-health-inc/fhir-ips"

export interface AlgorithmInput {
  studyUID: string
  imageIds: string[]
  imagingStudy: ImagingStudy
  patientReference: string
  accessToken: string | null
}

export interface AlgorithmResult {
  title: string
  description: string
  confidence?: number
  code?: { system: string; code: string; display: string }
  severity?: "info" | "warning" | "critical"
}

export async function runAlgorithm(input: AlgorithmInput): Promise<AlgorithmResult> {
  // Your algorithm logic here
  return {
    title: "Finding Title",
    description: "What was detected...",
    confidence: 0.95,
    severity: "info",
  }
}
```

### AlgorithmInput

| Field | Type | Description |
|---|---|---|
| `studyUID` | `string` | DICOM Study Instance UID |
| `imageIds` | `string[]` | Cornerstone3D `wadors:` image IDs for pixel-level access |
| `imagingStudy` | `ImagingStudy` | Full FHIR ImagingStudy resource from the EHR |
| `patientReference` | `string` | FHIR patient reference, e.g. `"Patient/123"` |
| `accessToken` | `string \| null` | OAuth2 Bearer token for authenticated API calls |

### AlgorithmResult

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Short title displayed in the result card |
| `description` | `string` | Detailed description of the analysis result |
| `confidence?` | `number` | Score between 0 and 1 (shown as percentage in UI) |
| `code?` | `{ system, code, display }` | Clinical code (e.g. SNOMED CT, LOINC) |
| `severity?` | `"info" \| "warning" \| "critical"` | Controls result card color (default: `"info"`) |

## SMART Configuration

Configured in `src/config.ts`:

```typescript
/// <reference types="vite/client" />
import { createSmartAppConfig } from '@proxy-smart/shared-ui'

export const config = createSmartAppConfig({
  clientId: 'smart-dicom-template',
  scopes: 'openid fhirUser patient/ImagingStudy.read patient/DiagnosticReport.write',
  env: import.meta.env,
})
```

| Field | Value |
|---|---|
| Client ID | `smart-dicom-template` |
| Scopes | `openid`, `fhirUser`, `patient/ImagingStudy.read`, `patient/DiagnosticReport.write` |
| Redirect URI | `{base}/callback` |

## How It Works

1. **SMART Launch** -- `SmartAppShell` handles OAuth 2.0 + PKCE flow via `createSmartAuth()`
2. **Study Fetch** -- `AlgorithmRunner` queries `GET /ImagingStudy?patient={id}` using the FHIR bearer token
3. **Study Selection** -- User picks a study from the card grid (with thumbnails via DICOMweb)
4. **Image Loading** -- Cornerstone3D initializes, then loads all series image IDs via `@babelfhir-ts/dicomweb/cornerstone`
5. **Algorithm Execution** -- `runAlgorithm()` receives image IDs and study metadata
6. **Result Display** -- Result card shows title, description, confidence, severity, and clinical code

## Development

| Command | Description |
|---|---|
| `bun run dev` | Start dev server on port 5180 |
| `bun run build` | Production build |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | ESLint |

## Project Structure

```
src/
├── algorithm.ts          # ← YOUR CODE GOES HERE
├── App.tsx               # SmartAppShell wrapper
├── config.ts             # SMART client configuration
├── main.tsx              # React entry point
├── index.css             # Tailwind CSS
├── components/
│   └── AlgorithmRunner.tsx  # Study selector + algorithm runner UI
└── lib/
    ├── smart-auth.ts        # createSmartAuth() instance
    ├── dicomweb.ts          # DICOMweb client (thumbnails, series loading)
    ├── cornerstone-init.ts  # Lazy Cornerstone3D + DICOM loader init
    └── auth-error.ts        # Shared auth error handler (re-export)
```

## Key Libraries

| Library | Purpose |
|---|---|
| `@proxy-smart/shared-ui` | SmartAppShell, createSmartAuth, UI components |
| `@babelfhir-ts/dicomweb` | DICOMweb client (QIDO-RS, WADO-RS, thumbnails) |
| `@babelfhir-ts/dicomweb/cornerstone` | Cornerstone3D integration for series loading |
| `@cornerstonejs/core` | Medical image rendering engine |
| `@cornerstonejs/dicom-image-loader` | DICOM P10 / WADO-RS image loader |
| `hl7.fhir.uv.ips-generated` | FHIR R4 TypeScript types (ImagingStudy, etc.) |
| `lucide-react` | Icons (Play, ImageIcon, AlertTriangle, etc.) |
