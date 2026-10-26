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

`runAlgorithm()` receives a study's image IDs and its FHIR metadata and returns a finding. The template supplies the rest: a local `AppShell` drives the OAuth 2.0 and PKCE launch through `SmartFhirClient` from `@babelfhir-ts/client-r4`, `@babelfhir-ts/dicomweb` retrieves studies, series, and instances, and Cornerstone3D loads WADO-RS pixel data with the access token injected into each request. The study selector, run control, and result card are already built against that interface, so a returned result renders without any UI work.

## Quick Start

```bash
# 1. Copy the template
git clone https://github.com/proxy-smart/smart-dicom-template my-algorithm

# 2. Update package.json name, port, and clientId in src/config.ts
# 3. Implement your algorithm in src/algorithm.ts
# 4. Register as a SMART app in Proxy Smart admin

cd my-algorithm
bun install
bun run dev
# -> http://localhost:5180/apps/smart-dicom-template/
```

## Algorithm Interface

Your algorithm lives in `src/algorithm.ts`. Implement the `runAlgorithm` function:

```typescript
import type { ImagingStudy } from "fhir/r4"

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

`src/config.ts` resolves everything from Vite env vars, with no shared config package, so a clone owns its configuration outright. See `.env.example` in the template.

| Field | Default | Override |
|---|---|---|
| Client ID | `smart-dicom-template` | `VITE_CLIENT_ID` |
| Scopes | `openid fhirUser patient/ImagingStudy.read patient/DiagnosticReport.write` | `VITE_SCOPES` |
| Redirect URI | `{base}/callback` | `VITE_REDIRECT_URI` |
| FHIR base URL | `{proxy}/proxy-smart-backend/hapi-fhir-server/R4` | `VITE_FHIR_BASE_URL`, or `VITE_PROXY_PREFIX` / `VITE_FHIR_SERVER_ID` / `VITE_FHIR_VERSION` |
| DICOMweb base URL | `{proxy}/dicomweb` | `VITE_DICOMWEB_BASE_URL` |

## How It Works

1. **SMART Launch** -- `AppShell` runs the authorize, callback and token lifecycle through `SmartFhirClient` (`src/lib/smart-auth.ts`)
2. **Study Fetch** -- `AlgorithmRunner` searches `ImagingStudy?patient={id}` through the typed `fhir` client; a lost session is reported to `lib/auth-error.ts` and the shell returns to sign-in
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
├── App.tsx               # AppShell wrapper
├── config.ts             # SMART client configuration
├── main.tsx              # React entry point
├── index.css             # Tailwind CSS
├── components/
│   ├── AppShell.tsx         # Sign-in, callback and session states
│   ├── AlgorithmRunner.tsx  # Study selector + algorithm runner UI
│   └── ui/                  # Local button, card, spinner
└── lib/
    ├── smart-auth.ts        # SmartFhirClient session, typed FHIR client, access token
    ├── dicomweb.ts          # DICOMweb client (thumbnails, series loading)
    ├── cornerstone-init.ts  # Lazy Cornerstone3D + DICOM loader init
    └── auth-error.ts        # Lost-session bus between fetches and the shell
```

## Key Libraries

| Library | Purpose |
|---|---|
| `@babelfhir-ts/client-r4` | `SmartFhirClient` (SMART launch, PKCE, token refresh) and the typed FHIR client |
| `@babelfhir-ts/dicomweb` | DICOMweb client (QIDO-RS, WADO-RS, thumbnails) |
| `@babelfhir-ts/dicomweb/cornerstone` | Cornerstone3D integration for series loading |
| `@cornerstonejs/core` | Medical image rendering engine |
| `@cornerstonejs/dicom-image-loader` | DICOM P10 / WADO-RS image loader |
| `@types/fhir` | FHIR R4 TypeScript types (ImagingStudy, etc.) |
| `lucide-react` | Icons (Play, ImageIcon, AlertTriangle, etc.) |
