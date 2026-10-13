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

### Searching

- `code` takes exactly one state code. A comma separates search values in FHIR, so `code=a,b` is refused with `400`; write `\,` for a literal comma.
- Query values are percent-decoded and nothing else: a literal `+` is a plus sign, as is `%2B`, and only `%20` is a space. Form encoding, where `+` stands for a space, does not apply to FHIR search URLs.
- `subject%3Amissing=true` is read the same as `subject:missing=true`.
- A search that finds nothing answers a `Bundle` with `total: 0` and no `entry`, since FHIR JSON never carries an empty array.

### Resource rules

A request body is a `Basic` resource conforming to [`smart-app-state-basic`](https://hl7.org/fhir/smart-app-launch/STU2.2/StructureDefinition-smart-app-state-basic.html):

- `code.coding` holds exactly one Coding with a `system` and a `code`. The pair `system|code` is the state code.
- `subject.reference`, when present, is an absolute reference to a `Patient`, `Practitioner`, `PractitionerRole`, `RelatedPerson` or `Person` on a FHIR server this proxy serves, for example `https://api.example.org/proxy-smart-backend/hapi/R4/Patient/123`. Omit `subject` for global state.
- Top-level extensions carry `valueString` only and no nested extensions. The proxy stores them unmodified and never interprets them.
- A create must not carry `id` or `meta.versionId`; the proxy assigns both.

### Concurrency

Versions are integers, and the ETag is `W/"{versionId}"`. The checks on an update or delete run in this order:

1. An `id` that was deleted, or never existed, answers `412 Precondition Failed`, whatever the request carries. The spec has the server process every later request about a deleted `Basic.id` as a failed precondition, so this comes before the body or headers are looked at.
2. A missing `If-Match` answers `400`, as FHIR R4 prescribes for a server that requires version-aware updates.
3. On an update, an invalid body, or a `Basic.id` that does not match the URL, answers `400` (`413` above the size limit).
4. Authorization, below, answers `403`.
5. An `If-Match` that does not name the current version answers `412`, as does an update that changes `Basic.code` or `Basic.subject`.

## Authorization

Three checks run on every request, and all three must pass.

**1. The subject belongs to the token.** A subject is allowed when it is the in-context patient (the `patient` launch context, or a `Patient` fhirUser) or the in-context user (`fhirUser`, including the one resolved at token issuance), on the FHIR server that context belongs to. Any other subject is refused; the proxy does not decide whether a practitioner may reach an arbitrary patient's state.

The proxy can front several FHIR servers, and `Patient/123` on one is a different patient from `Patient/123` on another. The token's context is bound to a server as follows:

- An absolute `fhirUser` names its own server.
- Otherwise the token's `aud` must name exactly one FHIR server this proxy serves, by its proxied base (`{BASE_URL}/{name}/{server}/{version}`) or by its upstream base.
- With a single FHIR server configured, that server is the context.
- In a multi-server deployment, a token whose `aud` names no server, or several, has no patient or user context here, and every request about a subject is refused with a `403` that says so. Have the app pass `aud` (or RFC 8707 `resource`) for the server it launched against.

**2. The app is registered for the state code.** As the spec describes, each SMART app carries, per state code, whether it may query or modify state when the subject is the in-context patient, the in-context user, or absent (global). Query covers search; modify covers create, update and delete, and does not include query. The sets are managed in the admin API (`POST` and `PUT /admin/smart-apps/{clientId}`) or the MCP tools generated from it:

| Field | Grants |
|---|---|
| `appStatePermissions` | Exactly the sets named, for example `{"patient": {"query": ["https://myapp.example.org\|encrypted-phr-access-keys"]}}` for a provider-facing companion that reads what the patient app stores |
| `appStateCodes` | Shorthand: query and modify for the in-context patient and user, and query global state |
| `appStateGlobalCodes` | Shorthand: everything `appStateCodes` grants, plus modifying global state. Reserve for administrative apps |

The three fields add up, so registrations made before `appStatePermissions` existed keep their meaning. `appStatePermissions` has the keys `patient`, `user` and `global`, each with optional `query` and `modify` lists; sending it replaces what is stored, and `{}` clears it.

Codes are written `system|code`. Register an app only for codes whose `system` is an origin you have verified it controls. Grant a companion app `query` alone unless it must write: the registration, not the token's scopes, keeps a companion holding broad scopes such as `patient/*.cruds` from changing or deleting another app's state. The token's `azp` identifies the app.

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

The limit holds under concurrent creates: in PostgreSQL the count and the insert run in one transaction behind an advisory lock on the state code and subject, and the in-process stores check and insert without yielding.

With `DATABASE_URL` (or the `PG*` variables) set, App State lives in the `smart_app_state` PostgreSQL table, shared by every backend task. Without a database it is kept in `DATA_DIR/app-state.json`, which suits a single local instance only. App State is retained until the app deletes it; deregistering an app removes its access, not the data, so state shared with a companion app survives.

App State can hold secrets such as encryption keys. Treat the database and data directory accordingly, and tell users at authorization time that what an app stores becomes part of their health record.
