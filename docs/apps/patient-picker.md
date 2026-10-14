# Patient Picker

Embedded context selection UI shown during SMART standalone launch flows when patient or encounter context is needed.

The Patient Picker is **not a standalone SMART app**. The backend renders it mid-authorization: when a SMART app requests `launch/patient` or `launch/encounter` in a standalone launch, there is no EHR to supply the context, so the flow pauses here for the user to choose it before the authorization completes.

One bundle serves three modes, selected by the `choose` URL parameter:

| Mode | `choose` | Shown when |
|---|---|---|
| Patient | (absent) | A practitioner launches a standalone app that needs a patient (`launch/patient`, a `patient/` scope, or `launch/encounter`) |
| Identity | `identity` | The signed-in Person links to several identities and the request does not settle which one |
| Encounter | `encounter` | The app asked for `launch/encounter` and the patient is known, either picked here or from a Patient `fhirUser` |

```
┌────────────────┐   authorize   ┌──────────────┐   redirect   ┌────────────────┐
│ Requesting App │ ────────────► │  Proxy Smart │ ────────────► │ Patient Picker │
│ (SMART app)    │               │  /auth       │               │ /patient-picker│
└────────────────┘               └──────────────┘               └───────┬────────┘
                                                                        │
                                                                        │ POST /auth/patient-select
                                                                        │ POST /auth/encounter-select
                                                                        ▼   (launch/encounter only)
                                                                ┌──────────────┐
                                                                │ Authorization│
                                                                │ completes    │
                                                                └──────────────┘
```

## How It Works

1. User initiates a standalone SMART launch from a client app
2. Backend detects `launch/patient` scope but no patient context
3. Backend redirects to `/patient-picker/?session=...&code=...&aud=...`
4. Patient Picker renders a searchable patient list from the FHIR server
5. User selects a patient and clicks "Continue"
6. Patient Picker POSTs to `/auth/patient-select` with `{ session, code, patient }`
7. Backend binds the patient to the session. Without `launch/encounter` it redirects to the app with the code; the patient reaches the token response
8. With `launch/encounter`, the backend instead returns `/patient-picker/?choose=encounter&session=...&code=...&aud=...`
9. The encounter mode lists the patient's encounters from `GET /auth/encounter-search`, newest first, at most 50
10. User selects an encounter, and the picker POSTs `{ session, code, encounter }` to `/auth/encounter-select`. A patient with no encounters, or a failed search, offers "Continue without an encounter" instead, which posts no `encounter`
11. Backend binds the encounter and redirects to the app; the token response carries `encounter`

A patient user whose `fhirUser` is a Patient skips steps 3 to 7 and starts at step 8.

## Backend endpoints

All are keyed by the launch session, since no token exists yet.

| Endpoint | Purpose | Guard |
|---|---|---|
| `GET /auth/patient-search` | Patient search against the server in `aud` | Session cleared for the picker by the callback gate (practitioners only) |
| `POST /auth/patient-select` | Records the chosen patient | Same gate |
| `GET /auth/encounter-search` | `Encounter?patient=<session patient>&_sort=-date&_count=50` | Session awaiting an encounter for a known patient; the patient comes from the session, never from the request |
| `POST /auth/encounter-select` | Records the chosen encounter | The id must be one the last search returned |
| `GET /auth/identity-options`, `POST /auth/identity-select` | Identity mode | Only the identities the callback offered |

## URL Parameters

| Parameter | Description |
|-----------|-------------|
| `session` | Backend session ID for the in-progress authorization |
| `code` | Authorization code from Keycloak |
| `aud` | FHIR server base URL (used for patient search) |

Because it interrupts a flow the user is already committed to, the UI stays deliberately thin: a searchable patient list, names rendered through `formatHumanName()` from shared-ui, and an explicit error when a required parameter is missing. There is no sign-out, no navigation, and no authentication of its own.

## Development

```bash
cd packages/patient-picker
bun run dev
# -> http://localhost:5176/patient-picker/
```

| Command | Description |
|---|---|
| `bun run dev` | Start dev server on port 5176 |
| `bun run build` | Production build |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | ESLint |

## Key Components

| Component | Purpose |
|---|---|
| `PatientList` | Fetches and displays searchable list of FHIR Patient resources |
| `EncounterList` | Lists the selected patient's encounters with period, location, status and class |
| `IdentityList` | Lists the identities the sign-in offered, labelled by role |
| `SelectableRow` | The selectable card row both lists render |
| `App` | Orchestrates parameter parsing, the mode, selection state, and submission |

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19, TypeScript |
| Build | Vite, Tailwind CSS |
| UI | `@proxy-smart/shared-ui` (AppHeader, Button, formatHumanName) |
| FHIR | FHIR R4 Patient and Encounter search via fetch |

## Notes

- This app does **not** use `SmartAppShell` because it's not a SMART app itself -- it has no authentication flow
- It receives its FHIR base URL from the `aud` parameter (set by the backend during redirect)
- The lists read the FHIR server through the backend's session-checked search endpoints above, never directly
