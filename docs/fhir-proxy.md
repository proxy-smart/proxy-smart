# FHIR Proxy

The FHIR proxy is the core component of Proxy Smart. It sits between SMART apps and upstream FHIR servers, providing authentication, authorization, consent enforcement, and capability-aware request normalization.

## Route Structure

All proxied FHIR requests follow this URL pattern:

```
{BASE_URL}/proxy-smart-backend/{server_name}/{fhir_version}/{resource_path}
```

For example:
```
https://api.proxy-smart.com/proxy-smart-backend/hapi-fhir/R4/Patient/123
```

| Segment | Description |
|---|---|
| `proxy-smart-backend` | Fixed prefix (derived from the backend package name) |
| `server_name` | Identifier of a registered FHIR server (see [FHIR Servers](admin-ui/fhir-servers)) |
| `fhir_version` | FHIR version -- `R4`, `R5`, etc. (configured via `FHIR_SUPPORTED_VERSIONS`) |
| `resource_path` | Standard FHIR path -- `Patient/123`, `Observation?patient=123`, etc. |

## Request Pipeline

Every proxied request passes through a seven-stage pipeline:

### 1. Authentication

#### Access posture

Each enforcement stage below runs in one mode: `enforce`, `audit-only` (logs what `enforce` would refuse, then allows it) or `disabled`. The intended mode of every stage is declared once, in [`backend/src/lib/access-posture.json`](../backend/src/lib/access-posture.json). Changing the posture of every deployment is an edit to that file.

Two layers can override it for one deployment:

- **Saved admin settings** (Admin UI, `/admin/consent/config`, `/admin/smart-access-control/config`), stored as realm attributes. Only the fields that differ from the defaults are saved, so a saved exemption does not pin the mode.
- **Environment variables** (`CONSENT_MODE`, `SCOPE_ENFORCEMENT_MODE`, `ROLE_BASED_FILTERING_MODE`, `FHIR_AUDIENCE_ENFORCEMENT`), for a self-hosted deployment that needs a different default.

The deployments of this repository set no environment variable for these. The enforcement probe (`.github/scripts/consent-enforcement-probe.mjs`) reads the same file and fails when a deployment enforces less than it declares.

All requests (except `GET /metadata`) require a valid Bearer token. The token is validated against Keycloak's JWKS endpoint. If validation fails, the proxy returns `401`.

#### Audience binding

SMART App Launch: "The resource server also validates that the `aud` parameter associated with the authorization matches the resource server's own FHIR endpoint." The proxy forwards the `aud` (or `resource`) of an authorize request to Keycloak as an RFC 8707 resource indicator, so a token obtained through the proxy carries the FHIR base it was authorized for in its `aud` claim. A token is bound to the server it reaches (`/{server}/{version}`, paging links at the server base included) when its `aud` holds:

- that server's FHIR base: the route base, its RFC 8707 resource URL (`{BASE_URL}/proxy-smart-backend/{identifier}/{fhirVersion}`) or the upstream server's own base, matched exactly apart from a trailing slash, or
- the id of the Keycloak resource client whose `resource_url` is that base (`fhir-resource-server`, which is what an RFC 8693 exchange for it carries), provided no other resource server is in `aud`. A token the resource indicator was never applied to holds every resource client of the `resource-indicators` scope, so it is bound to none of them.

A token authorized for another FHIR server, or issued to another client of the realm (`aud: account`, the admin UI, an MCP resource URL), is not bound. `FHIR_AUDIENCE_ENFORCEMENT` decides what happens to it:

| Mode | Behavior |
|---|---|
| `enforce` | `401` with `WWW-Authenticate: Bearer error="invalid_token"` and the reason |
| `audit-only` (default) | admitted; the log line `FHIR access token is not bound to this server` names the server, `aud`, `azp` and why `enforce` would refuse the token |
| `disabled` | `aud` is not looked at |

The default is `audit-only` because tokens issued before the resource indicator was wired, and tokens of clients that bypass the proxy's authorize endpoint, carry `aud: account`. Watch the audit log before switching to `enforce`. The per-server MCP endpoint (`/fhir/{server}/mcp`) is a resource of its own with its own audience and is not subject to this check; its tool calls still run through the stages below. `JWT_AUDIENCE_ENFORCEMENT` is unrelated: it governs the admin and MCP call sites.

### 2. Operation Policy

Some requests are refused whatever the token's scopes say, and regardless of `SCOPE_ENFORCEMENT_MODE`: no SMART grant covers them.

| Request | Result |
|---|---|
| Server administration operations: `$expunge`, `$reindex`, `$reindex-terminology`, `$perform-reindexing-pass`, `$mark-all-resources-for-reindexing`, `$get-resource-counts`, `$trigger-subscription`, the HAPI merge and replace-references operations, and code system uploads | `403` |
| `$export` and `$export-poll-status` without a `system/` scope | `403`. Bulk Data export is for SMART Backend Services. |
| `DELETE` with `_expunge` or `_cascade` | `403` |

Purging data is still possible for the one case a patient is entitled to it: see [Record Erasure](#record-erasure).

### 3. Client Server Access

A SMART app registered with a server restriction (`serverAccessType` and `allowedServerIds` in the admin API, stored as the `server_access_type` and `allowed_server_ids` client attributes) is held to it on every FHIR request its tokens make, identified by the token's `azp` (else `client_id`). This covers single requests, every entry of a batch or transaction, and the per-server MCP tools.

| `serverAccessType` | The request is admitted when |
|---|---|
| `all-servers`, or not set and no `allowedServerIds` | always |
| `selected-servers`, or not set with `allowedServerIds` | the server's identifier is in `allowedServerIds` (an empty list admits nothing) |
| `user-person-servers` | the token's user has a Person on this server (the `fhir_persons` user attribute); a service account has none |

A refusal is `403 server_not_permitted`. A restriction an administrator configured is not a mode: it holds whatever `SCOPE_ENFORCEMENT_MODE` says. The client configuration is read through the client config cache (five minutes, cleared when the app is edited on that node). If Keycloak cannot be asked, the request is refused with `503` rather than admitted unchecked.

### 4. Consent & IAL Enforcement

When consent enforcement is enabled (`CONSENT_MODE=enforce`), the proxy checks whether the token holder has consent to access the requested resource.

This means the FHIR `Consent` resource throughout -- the patient's standing decision about who may reach their data. It is unrelated to the OAuth consent screen (Keycloak's `consentRequired` on a client), where a user approves the scopes an app asked for. That grants access to nobody's record.

The rule: **a patient's data may be reached by someone else only if the patient consented to that someone.**

- The consent service evaluates the request against FHIR Consent resources
- Identity Assurance Level (IAL) checks verify the trust level of the Person→Patient link
- If consent is denied, the proxy returns `403` with details:
  - `consent_denied` -- no active consent for this access
  - `ial_verification_failed` -- identity assurance level insufficient

Consent enforcement has three modes:
| Mode | Behavior |
|---|---|
| `disabled` | No consent checks (default) |
| `audit-only` | Checks consent and logs decisions, but never blocks requests |
| `enforce` | Blocks requests without valid consent |

#### Whose consent is evaluated

The patient the **token** is about, resolved in this order: a `patient` claim, then the launch context captured at token exchange, then `fhirUser` when it names a `Patient`. The requested URL is a last resort only, used when the token identifies no patient at all.

The URL never outranks the token. Judging the URL's patient would check a token for one patient against another patient's consent.

#### Which consents apply

`provision.actor` is the **grantee** -- the recipient the consent names. An actor matches when it references the requesting `fhirUser` (for example `Practitioner/dr-123`, which is what the consent app writes when a patient approves an access request), or when its reference or identifier carries the OAuth client id (for grants written against an app rather than a person).

A provision with **no actor names no recipient and therefore grants nothing.** An actor carrying only a `display` and no reference -- as an SHL mirror does -- likewise grants no FHIR access.

#### Self-access

A patient reaching their own record is not a disclosure, so no Consent is required and the check is skipped. This is decided **per request**, by comparing the token's `fhirUser` to the patient the request is about -- not per client. A client serving both patients and practitioners is therefore skipped for the patient and still enforced for the practitioner, which `CONSENT_EXEMPT_CLIENTS` cannot express.

Self-access answers only *whether the patient consented*. It does not decide *which* record may be read -- see Role-Based Data Isolation below, which must be enforcing for that.

### 5. SMART Scope Enforcement

When enabled (`SCOPE_ENFORCEMENT_MODE=enforce`), validates that the token's scopes grant permission for the requested operation.

- Supports SMART v1 format (`patient/Observation.read`) and v2 format (`patient/Observation.cruds`)
- A v2 suffix must be an in-order subset of `.cruds` (`.cu`, `.rs`, `.ds`). An out-of-order or repeated suffix (`.sr`, `.dus`, `.rr`) grants nothing, as the spec allows ("MAY be ignored"), and the admin API refuses to create such a scope
- Interactions map to permissions as the spec's table does: read, vread and instance history `r`; type-level and system-level history `s`; search (GET or `POST _search`) `s`; create `c`; update and patch `u`; delete and `$erase` `d`
- Wildcard scopes (`patient/*.read`) match any resource type
- A compartment search (`Patient/123/Observation`) is judged by the type it returns
- A search or history across all types at the server base (`GET [base]?_type=...`, `POST [base]/_search`, `GET [base]/_history`) needs an unconstrained wildcard search scope such as `system/*.rs`. A paging link (`GET [base]?_getpages=...`) needs a valid token only, since the search it continues was authorised when it ran
- `_include` and `_revinclude` (also with `:iterate`) return resources of other types, so the token needs an unconstrained `r` or `s` scope for every type they return: the target type of `_include=Observation:performer:Practitioner`, the source type of `_revinclude=Provenance:target`. An include that does not name the type it returns (`_include=Observation:subject`, `_include=*`) is admitted only under an unconstrained wildcard read scope such as `patient/*.rs`; name the type to use it with granular scopes. `patient` and `medication` count as naming `Patient` and `Medication`, their only R4 target. Includes in the form body of a `POST _search` are checked as well
- Returns `403` if the requested operation exceeds granted scopes; `audit-only` logs each refusal and admits the request

#### Search-parameter constraints (SMART 2.0)

A scope may carry a query suffix that narrows it, e.g. `patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory`. An unconstrained scope for the same type still grants full access; several constrained scopes grant the union of their constraints.

| Request under constrained scopes only | Result |
|---|---|
| Search | The constraint is added to the query (several constraints on one parameter as a FHIR OR). A search already asking for no more than one constraint allows is left alone |
| Search with `_include`, `_revinclude` or `_contained` | `403`: these return resources outside the constraint |
| Read by id | Checked upstream with `_id={id}` plus the constraint; `403` if it does not match, `502` if the check fails |
| Create | The body must satisfy the constraint |
| Update | The body must satisfy the constraint, and the stored resource too if it exists |
| Delete | The stored resource must satisfy the constraint |
| Patch, conditional writes, history, operations | `403`: the result cannot be checked |

On a body, the proxy evaluates the token parameters `category`, `code`, `status`, `clinical-status`, `verification-status`, `intent`, `type`, `class`, `identifier`, `gender`, `priority` and `criticality`. A constraint on anything else, or with a modifier or chain, refuses the write. A read is refused when the upstream CapabilityStatement does not declare the constraint's parameter. `audit-only` logs these decisions without applying them.

### 6. Role-Based Data Isolation

When enabled (`ROLE_BASED_FILTERING_MODE=enforce`), confines a request to one patient's FHIR compartment. This is the only stage that decides **which** patient may be read or written; scope enforcement checks resource types, and consent checks who may receive data.

Two rules, in order:

**A `patient/`-scoped grant is confined to one patient**, whoever the user is -- per SMART, "if the app has any patient-level scopes, they will be scoped to Patient 123". The patient is resolved the same way consent resolves it: `patient` claim, then the launch context captured at token exchange, then `fhirUser` when it names a `Patient`. A token holding `patient/` scopes with none of those resolving is refused, rather than widened to the whole server.

**A user who IS a patient** (`fhirUser: Patient/…`) sees only their own data.

Either way the compartment is the [FHIR R4 Patient CompartmentDefinition](https://hl7.org/fhir/R4/compartmentdefinition-patient.html), held as a typed table in `backend/src/lib/patient-compartment/definition.ts`. For each of its 66 resource types the table names the search parameter that narrows a search to one patient (`patient` where R4 defines it, otherwise the definition's own: `subject` for `AdverseEvent` and `SupplyRequest`, `member` for `Group`, `actor` for `Schedule`), the elements that parameter searches, and every reference element the definition lists. Types outside the compartment (`Practitioner`, `Organization`, `Medication`, terminology, ...) are not patient data and pass unchanged. It is applied as:

| Request | Result |
|---|---|
| `GET Patient?…` | `_id={ownId}` injected |
| `GET Patient/{other}`, `GET Patient/{other}/Observation` | `403` |
| `GET Observation`, `GET Appointment`, ... (any compartment type) | the type's parameter injected, e.g. `patient=Patient/{ownId}`, `subject=Patient/{ownId}` for `AdverseEvent` |
| `GET Encounter/{id}/Observation` | narrowed by the target type's parameter |
| `GET Observation/{id}`, its `_history`, or an instance operation by any method | ownership verified upstream with `_id` and the type's parameter; `403` if the resource is not the patient's |
| `POST Observation/_search` | the parameter added to the URL, which the server combines with the form body |
| `GET [base]?_type=…`, `[base]/_history`, `POST [base]/_search`, operations at the base | `403`: they span every type and no parameter can confine them (`metadata` still answers) |
| `GET Observation/_history`, `Observation/$lastn`, `Patient/$everything` (type level, compartment types) | `403`, for the same reason |
| `POST Observation` | the body must be in the patient's compartment; `403` otherwise |
| `PUT Observation/{id}` | the stored resource (if any) and the new body must both be in the compartment |
| `PATCH Observation/{id}` | the stored resource must be in the compartment, and the patch may not touch the elements that decide it |
| `DELETE Observation/{id}` | the stored resource (if any) must be in the compartment |
| `POST Binary`, `PUT`/`PATCH`/`DELETE Binary/{id}`, `GET Binary/{id}` | judged by `Binary.securityContext`, see below |
| `GET Binary`, `POST Binary/_search`, `Binary/_history`, `Binary/{id}/_history`, Binary operations | `403`: R4 gives Binary no patient search parameter |

#### Writes

Writes use the same table, so whatever a confined grant writes, its confined search finds again. A written resource must reference the patient through an element its search parameter covers (`Observation.subject`, `AllergyIntolerance.patient`, `Appointment.participant.actor`, ...), and may not reference any other patient through any element the definition lists (`Observation.performer`, `Communication.recipient`, ...), so a write never reaches into another patient's record. A `Patient` belongs to its own compartment by id only.

The stored resource is read upstream with `_id={id}` and judged by the same rule. Whatever cannot be evaluated is refused:

- a type outside the Patient compartment (`Practitioner`, `Organization`, ...), or a new `Patient`
- a body that is not JSON, or a reference that does not resolve to `Type/id` on this server (`urn:uuid:`, `#contained`, conditional references, other servers)
- conditional create (`If-None-Exist`), conditional update, patch and delete, and cascading deletes (`_cascade`, `X-Cascade`)
- a JSON Patch or FHIRPath Patch operation on `id` or a compartment element, or one whose path is not a plain element path
- `502` when the stored resource cannot be read upstream

#### Binary

R4 leaves `Binary` out of the CompartmentDefinition and says instead that access to a Binary follows the resource its `securityContext` references. A confined grant treats that reference as the Binary's compartment link, so it may create, update, patch, delete or read a Binary only when the Binary's `securityContext` references the grant's own patient (`Patient/{ownId}`, relative or under this server's base). A missing `securityContext`, one that references another patient or any other resource type, and a raw-bytes body (`Content-Type: image/png`, `model/gltf-binary`, ...) are refused, because raw bytes carry no `securityContext`. Upload the content as a JSON Binary instead:

```json
{ "resourceType": "Binary", "contentType": "model/gltf-binary", "securityContext": { "reference": "Patient/{ownId}" }, "data": "<base64>" }
```

A read by id fetches the stored Binary as JSON (`Binary?_id={id}`) and checks its `securityContext`, so the bytes can still be requested with `Accept: <contentType>`. A patch may not touch `securityContext`.

#### Modes

`enforce` applies everything above. `audit-only` evaluates the same decisions for a `patient/` grant and for a patient user alike, upstream ownership checks included, and changes nothing: a search it would narrow goes upstream as sent (logged as `Patient-compartment narrowing not applied (audit-only)` with the query `enforce` would send), and a read or write it would refuse is admitted (logged as `Read outside the patient compartment` or `Write outside the patient compartment` with `wouldDeny: true`). `disabled` checks nothing. The default is `audit-only`, so a deployment that relies on the compartment, for patient users as much as for `patient/` grants, sets `enforce`.

#### Linked Patients (`Patient.link`)

SMART requires a server that supports linking Patient records through `Patient.link` to describe how authorization treats them. Here the compartment is the one patient the grant is confined to, by id. A Patient linked to it (`replaced-by`, `replaces`, `refer`, `seealso`), and the data filed under that other Patient, is **not** part of it: `GET Patient/{linked}` is refused, and the search narrowed with `patient=Patient/{ownId}` does not follow links. A merged record is reached only through the id the token's patient context names. The reasons:

- whether two records belong to the same person is the record holder's decision, and a link may be wrong, stale or one-sided; following it would let a grant reach a record the patient never chose
- the R4 CompartmentDefinition puts the *linking* Patient in the linked patient's compartment, not the reverse; a write is judged by id only, and widening reads across links would let either side of a link read the other
- the launch context names one patient; a client that needs a linked record asks for a launch with that patient

A Person resource (`Person.link`) is used only to resolve a Person `fhirUser` to its Patient on the server, never to widen the compartment.

A user with only `user/`-scoped access and a non-Patient `fhirUser` -- a practitioner -- is **not** compartment-filtered here. Their access is governed by consent instead.

> **Not yet implemented:** narrowing a practitioner to the patients assigned to them via `generalPractitioner`. There are no `generalPractitioner` links in the system yet and the proxy performs no such lookup, so nothing here bounds a practitioner to an assigned panel. Until it exists, **consent is the only thing limiting which patients a practitioner can reach** -- which makes actor matching (above) load-bearing rather than advisory.

### 7. Capability-Aware Normalization

The proxy fetches and caches each upstream server's `CapabilityStatement` to enable intelligent request handling.

#### Strict Mode (per-server opt-in)

When `strictCapabilities` is enabled on a FHIR server:

- **Interaction checks** -- rejects unsupported CRUD operations with `405`
- **History checks** -- rejects `_history` requests if the server doesn't declare history support
- **Operation checks** -- rejects `$operation` calls not declared in the CapabilityStatement
- **PATCH format checks** -- rejects PATCH with unsupported content types with `415`

#### Search Parameter Normalization (always active)

Regardless of strict mode, the proxy strips search parameters and `_include`/`_revinclude` values not declared by the upstream server. This prevents `400` errors from servers that reject unknown parameters. Stripped parameters are listed in the `x-proxy-stripped-params` response header.

A parameter that access control added (the patient compartment, tenant tag or a scope constraint) is never stripped: if the upstream server does not declare it, the request is refused with `403` instead of being widened.

## Batch and Transaction Bundles

`POST [base]` with a `Bundle` of type `batch` or `transaction` is authorised entry by entry, because every stage above keys off a request path. The body must be JSON, hold at most `FHIR_BUNDLE_MAX_ENTRIES` entries, and give each entry `request.method` and a `request.url` that is relative or absolute against this proxy's base for the server.

- **batch**: each entry runs through the whole pipeline as if it were its own request, and is sent upstream as one. The answer is a `batch-response` Bundle with each entry's `response.status`, `location`, `etag` and `lastModified`; a refused or invalid entry carries an `OperationOutcome` and the other entries still run.
- **transaction**: atomic, so it is never split. Every entry gets the operation policy, consent, tenant, scope (with constraints) and patient-compartment decisions, so a write entry is confined like a single write. If any is refused, the whole transaction is refused with an `OperationOutcome` whose `expression` names the entry. A search that the compartment, tenant or a scope constraint would have to narrow is admitted only when that narrowing is already in its query, because a transaction cannot be rewritten. An admitted transaction is forwarded upstream unchanged. `$erase` cannot be part of a transaction.

## Who Added a Record

Whenever a signed-in user (a token with `fhirUser`) creates a record through the proxy, by `POST`, by a `PUT` that creates, or inside a batch or transaction, the proxy writes a Provenance recording it:

- `target`: the record at the version it was created as (`Condition/123/_history/1`), plus the Patient whose chart it belongs to, so a patient-scoped `Provenance` search finds it
- `agent`: the user as `enterer`; `activity`: `CREATE`; `policy`: `https://proxy-smart.com/fhir/policy/added-by`
- `signature`: a JWS (`application/jose`) signed with the proxy signing key, whose claims bind the user (`sub`) to that creation (`tgt`)

Provenance and AuditEvent are not tracked this way, and neither are writes by backend services with no user behind them. A failure to write the Provenance is logged and the create still stands. Only the signature counts as proof: a client can write a Provenance with the same policy, but not one the proxy's key verifies.

## Record Erasure

`POST [base]/[type]/[id]/$erase` permanently removes one record the signed-in member added, together with its history. The proxy answers it rather than forwarding it, and the upstream server must support `$expunge`.

The right follows who added the record, not whom it is about: a member can erase what they entered or imported, a caregiver what they added to someone else's chart, and nobody a record that someone else added about them.

It runs after consent, tenant and scope checks, and the scope check treats it as a delete, so the token needs `d` (or `write`) on the resource type. The proxy then refuses with an `OperationOutcome` unless all of these hold:

| Check | Refusal |
|---|---|
| The user is a member (`fhirUser: Patient/…` or `Person/…`); clinicians mark records `entered-in-error` instead | `403` |
| The record is not a Patient, Person, Consent, Provenance or AuditEvent | `422` |
| A Provenance signed by this proxy names the user, or for a Person their own Patient, as having added the record at the version it was created as | `403` |
| No version has `verificationStatus` `confirmed`, and no version names a Practitioner, PractitionerRole or Organization as asserter, recorder, performer, requester, information source, author, attester or verifier | `409` |
| No Provenance about the record has such an agent | `409` |
| Nothing but Provenance references the record | `409`, naming the referencing resources |
| The upstream server advertises `$expunge` | `501` |

A record a clinician attested stays: mark it `entered-in-error` instead, which keeps the original recognisable as medical record law requires. A consent is withdrawn rather than erased, so the record of what was agreed stays.

When the checks pass, a Provenance about this record alone, or about it and its chart's Patient, is deleted; one about several records loses only this target; both are expunged. Then the record is deleted and expunged, including earlier versions. The proxy logs the erasure (reference and member, no content) and answers `200`.

## URL Rewriting

Response bodies are rewritten so that all FHIR resource URLs point back through the proxy rather than directly at the upstream server. This ensures clients always route through the proxy's access control pipeline.

## mTLS Support

Each FHIR server can be configured with mutual TLS (mTLS) certificates for upstream connections. When enabled, the proxy presents a client certificate when connecting to that server. See [FHIR Servers](admin-ui/fhir-servers) for configuration.

## SMART Configuration

Each FHIR server exposes a `/.well-known/smart-configuration` endpoint through the proxy, dynamically generated from Keycloak's OIDC configuration and cached for performance.

## Monitoring

All proxied requests are tracked with metrics including server name, HTTP method, resource type, status code, response time, and client ID. These metrics are available via the [Monitoring](admin-ui/monitoring) dashboard.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FHIR_SERVER_BASE` | Comma-separated upstream FHIR server URLs | `http://localhost:8081/fhir` |
| `FHIR_SUPPORTED_VERSIONS` | Comma-separated FHIR versions | `R4` |
| `CONSENT_MODE` | Consent enforcement mode: `disabled`, `audit-only`, `enforce`; only applies when `CONSENT_ENABLED=true` | [access posture](#access-posture) |
| `CONSENT_ENABLED` | Enable consent checks | on unless the posture's `consent` is `disabled` |
| `CONSENT_CACHE_TTL` | Consent decision cache TTL (ms) | `60000` |
| `CONSENT_EXEMPT_CLIENTS` | Comma-separated client IDs exempt from consent. Not needed for patient self-access, which is detected per request | -- |
| `CONSENT_REQUIRED_RESOURCE_TYPES` | Resource types that always require consent | -- |
| `CONSENT_EXEMPT_RESOURCE_TYPES` | Resource types exempt from consent | `CapabilityStatement,metadata` |
| `IAL_ENABLED` | Enable Identity Assurance Level checks | `false` |
| `IAL_MINIMUM_LEVEL` | Minimum IAL for general access | `level1` |
| `IAL_SENSITIVE_RESOURCE_TYPES` | Resource types requiring elevated IAL | -- |
| `IAL_SENSITIVE_MINIMUM_LEVEL` | Minimum IAL for sensitive resources | `level3` |
| `IAL_VERIFY_PATIENT_LINK` | Verify token patient matches Person.link[] | `true` |
| `IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE` | Allow access if Person lookup fails | `false` |
| `IAL_CACHE_TTL` | Person resource cache TTL (ms) | `300000` |
| `SCOPE_ENFORCEMENT_MODE` | Scope enforcement: `disabled`, `audit-only`, `enforce` | [access posture](#access-posture) |
| `ROLE_BASED_FILTERING_MODE` | Role-based filtering: `disabled`, `audit-only`, `enforce` | [access posture](#access-posture) |
| `FHIR_AUDIENCE_ENFORCEMENT` | Whether a token's `aud` must name the FHIR server it reaches: `disabled`, `audit-only`, `enforce` (see [Audience binding](#audience-binding)) | [access posture](#access-posture) |
| `FHIR_BUNDLE_MAX_ENTRIES` | Most entries accepted in a batch or transaction Bundle | `100` |
| `SMART_CONFIG_CACHE_TTL` | SMART configuration cache TTL (ms) | `300000` |
