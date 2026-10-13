# SMART App State

Proxy Smart implements the experimental [SMART App State](https://hl7.org/fhir/smart-app-launch/STU2.2/app-state.html) capability (`smart-app-state`) of SMART App Launch 2.2.0. Apps can keep a small amount of configuration, such as user preferences or the keys to an externally encrypted data set, without a backend of their own.

The proxy fronts FHIR servers it may not be able to write to, so it hosts the App State endpoint itself instead of forwarding `Basic` writes upstream. App State never mixes with the `Basic` resources on your FHIR servers and never shows up in their searches.

## Discovery

Every `.well-known/smart-configuration` the proxy serves lists the capability and the endpoint:

```json
{
  "capabilities": ["smart-app-state"],
  "associated_endpoints": [{
    "url": "https://api.example.org/app-state",
    "capabilities": ["smart-app-state"]
  }]
}
```

The endpoint's own CapabilityStatement is at `{BASE_URL}/app-state/metadata`. It instantiates the IG's `smart-app-state-server` CapabilityStatement and states the limits below.

## Interactions

| Request | Result |
|---|---|
| `POST /app-state/Basic` | `201` with the stored resource, `ETag: W/"1"` and `Location: .../Basic/{id}/_history/1` |
| `PUT /app-state/Basic/{id}` + `If-Match` | `200` with the next `ETag` |
| `DELETE /app-state/Basic/{id}` + `If-Match` | `204` |
| `GET /app-state/Basic?code={system\|code}&subject={reference}` | `Bundle` of the state for that subject |
| `GET /app-state/Basic?code={system\|code}&subject:missing=true` | `Bundle` of global (subject-less) state |

Every request needs an `Authorization: Bearer` access token issued by this deployment. Responses are `application/fhir+json`; errors are `OperationOutcome`s.

### Resource rules

A request body is a `Basic` resource conforming to [`smart-app-state-basic`](https://hl7.org/fhir/smart-app-launch/STU2.2/StructureDefinition-smart-app-state-basic.html):

- `code.coding` holds exactly one Coding with a `system` and a `code`. The pair `system|code` is the state code.
- `subject.reference`, when present, is an absolute reference to a `Patient`, `Practitioner`, `PractitionerRole`, `RelatedPerson` or `Person` on a FHIR server this proxy serves, for example `https://api.example.org/proxy-smart-backend/hapi/R4/Patient/123`. Omit `subject` for global state.
- Top-level extensions carry `valueString` only and no nested extensions. The proxy stores them unmodified and never interprets them.
- A create must not carry `id` or `meta.versionId`; the proxy assigns both.

### Concurrency

Versions are integers, and the ETag is `W/"{versionId}"`. Updates and deletes answer `412 Precondition Failed` when:

- `If-Match` is missing or does not name the current version,
- an update changes `Basic.code` or `Basic.subject`,
- the `id` was deleted, or never existed.

A `PUT` whose `Basic.id` does not match the URL is a `400`.

## Authorization

Three checks run on every request, and all three must pass.

**1. The state code is registered to the app.** Each SMART app carries two lists, managed in the admin API (`PUT /admin/smart-apps/{clientId}`) or the MCP tools generated from it:

| Field | Grants |
|---|---|
| `appStateCodes` | Query and modify state of these codes for the in-context patient and user, and query global state |
| `appStateGlobalCodes` | Everything above, plus modifying global state. Reserve for administrative apps |

Codes are written `system|code`. Register an app only for codes whose `system` is an origin you have verified it controls, and review cross-app sharing (a patient app and its provider-facing companion) case by case. The token's `azp` identifies the app.

**2. The subject belongs to the token.** A subject is allowed when its `Type/id` is the in-context patient (the `patient` launch context, or a `Patient` fhirUser) or the in-context user (`fhirUser`, including the one resolved at token issuance). Any other subject is refused; the proxy does not decide whether a practitioner may reach an arbitrary patient's state.

**3. A scope grants the interaction.** Search needs `s`, create `c`, update `u`, delete `d`:

| Subject | Accepted scopes |
|---|---|
| In-context patient | `patient/Basic.*` or `user/Basic.*` |
| In-context user | `user/Basic.*` |
| None (global) | `user/Basic.*` |

`*` as the resource type and SMART v1 `read`/`write` count too. A `code` parameter narrows a scope to one state code, as in `patient/Basic.cuds?code=https://myapp.example.org|encrypted-phr-access-keys`; a scope narrowed by any other parameter is not honoured.

App State always enforces these checks; `SCOPE_ENFORCEMENT_MODE` does not apply to it.

## Storage and limits

| Variable | Description | Default |
|---|---|---|
| `APP_STATE_MAX_RESOURCE_BYTES` | Largest accepted request body. Can only be raised above the spec's 256KB | `262144` |
| `APP_STATE_MAX_PER_SUBJECT` | Resources kept per state code and subject (or per state code for global state); further creates answer `422` | `20` |

With `DATABASE_URL` (or the `PG*` variables) set, App State lives in the `smart_app_state` PostgreSQL table, shared by every backend task. Without a database it is kept in `DATA_DIR/app-state.json`, which suits a single local instance only. App State is retained until the app deletes it; deregistering an app removes its access, not the data, so state shared with a companion app survives.

App State can hold secrets such as encryption keys. Treat the database and data directory accordingly, and tell users at authorization time that what an app stores becomes part of their health record.
