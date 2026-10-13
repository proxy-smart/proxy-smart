# Task-Based App Launch

SMART App Launch 2.1 added two experimental FHIR Task profiles that request the launch of a SMART app, for example as the outcome of a Clinical Reasoning or CDS Hooks workflow that recommends an app to staff ([spec](https://hl7.org/fhir/smart-app-launch/STU2.2/task-launch.html)):

| Profile | `Task.code` | Requests |
|---|---|---|
| [`task-ehr-launch`](https://hl7.org/fhir/smart-app-launch/STU2.2/StructureDefinition-task-ehr-launch.html) | `launch-app-ehr` | An EHR launch, with `Task.for` as the patient, `Task.encounter` as the encounter and an optional `appContext` |
| [`task-standalone-launch`](https://hl7.org/fhir/smart-app-launch/STU2.2/StructureDefinition-task-standalone-launch.html) | `launch-app-standalone` | A standalone launch |

Both codes, and the input types `smartonfhir-application` (the app URL, `valueUrl`) and `smartonfhir-appcontext` (the app context, `valueString`), come from `http://hl7.org/fhir/smart-app-launch/CodeSystem/smart-codes`.

Proxy Smart is the EHR side of an EHR launch, so it is also the party that acts on these Tasks: `POST /auth/launch/task` takes a launch Task and answers with the app launch URL to open.

## Request

`POST /auth/launch/task` with the caller's Bearer token and a JSON body carrying exactly one of:

| Field | Meaning |
|---|---|
| `task` | The launch Task itself |
| `taskReference` | A Task on the FHIR server: `Task/{id}`, a bare id, or an absolute URL on that server |
| `server` | Optional FHIR server identifier the launch is for; defaults to the first configured server |

A referenced Task is read through the proxy's own FHIR path with the caller's token. The scope, consent, tenant and role rules that guard any other FHIR read guard this one, so the caller needs a grant that covers reading the Task (for example `user/Task.rs`).

```json
{
  "task": {
    "resourceType": "Task",
    "status": "requested",
    "intent": "proposal",
    "code": { "coding": [{ "system": "http://hl7.org/fhir/smart-app-launch/CodeSystem/smart-codes", "code": "launch-app-ehr" }] },
    "for": { "reference": "Patient/123" },
    "encounter": { "reference": "Encounter/456" },
    "input": [
      {
        "type": { "coding": [{ "system": "http://hl7.org/fhir/smart-app-launch/CodeSystem/smart-codes", "code": "smartonfhir-application" }] },
        "valueUrl": "https://app.example.org/launch"
      },
      {
        "type": { "coding": [{ "system": "http://hl7.org/fhir/smart-app-launch/CodeSystem/smart-codes", "code": "smartonfhir-appcontext" }] },
        "valueString": "{\"field1\":\"value\"}"
      }
    ]
  }
}
```

## What the proxy checks

1. **The profile.** A `Task` with `status` and `intent`, a `code` carrying one of the two launch codes, exactly one `smartonfhir-application` input whose `valueUrl` is an absolute http(s) URL, and at most one `smartonfhir-appcontext` input as a `valueString`. Other inputs are allowed, since the input slicing is open. Every violation is listed in the `issues` of the 400 response.
2. **The status.** A Task that is `cancelled` or `entered-in-error` withdraws the request and is refused with 409.
3. **The app.** The application URL must be the launch URL of exactly one enabled SMART app registered with the proxy (the `launch_url` set in [SMART Apps](/admin-ui/smart-apps)). A fragment, a trailing slash and the case of the host are ignored; path and query must match. The proxy never sends a launch code to an app it does not know.
4. **The context (EHR launch).** `Task.for` must reference a Patient and `Task.encounter` an Encounter, as relative references or absolute URLs on the server the launch is for. A logical, contained or foreign-server reference cannot become launch context.
5. **The caller (EHR launch).** The launch code is minted through the same code as [`POST /auth/launch`](/oauth-authentication#ehr-launch): a patient may launch for their own record and a practitioner for any patient. The code is bound to the matched app's client id and to the caller.

## Response

```json
{
  "launch_type": "ehr",
  "launch_url": "https://app.example.org/launch?iss=https%3A%2F%2Fapi.example.org%2Fproxy-smart-backend%2Fhapi%2FR4&launch=eyJ...",
  "iss": "https://api.example.org/proxy-smart-backend/hapi/R4",
  "client_id": "cds-app",
  "launch": "eyJ...",
  "expires_in": 300,
  "task": "Task/task-for-ehr-launch"
}
```

Open `launch_url` in the user's browser. For an EHR launch it carries `iss` and `launch`, and the app continues with the regular EHR launch at `/auth/authorize`. For a standalone launch it carries `iss` only and no launch code is minted, so the app runs its own standalone launch and the user selects the context. Existing query parameters on the application URL are kept.

### appContext

The `appContext` input reaches the app the way a CDS Hooks Link's `appContext` does: as the `appContext` field of the token response, exactly as the Task carried it. `POST /auth/launch` accepts the same `appContext` field for EHRs that mint launch codes directly.

## Errors

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Both or neither of `task` and `taskReference`, a Task that does not conform to a profile (see `issues`), an unregistered or shared application URL, or context the server cannot provide |
| 401 | `unauthorized` | No or an invalid Bearer token, or the FHIR server did not accept it |
| 403 | `access_denied` | The caller may not read the Task, or may not launch for its patient |
| 404 | `not_found` / `invalid_request` | The Task or the FHIR server does not exist |
| 409 | `invalid_request` | The Task is `cancelled` or `entered-in-error` |
| 502 | `server_error` | Reading the Task failed upstream |
| 503 | `temporarily_unavailable` | The registered apps cannot be read from Keycloak |

## Task status and output

The specification defines no status transitions and no `Task.output` for a launch, so the proxy reads the Task and leaves it unchanged. Workflow engines that track whether a recommended app was opened update the Task themselves.
