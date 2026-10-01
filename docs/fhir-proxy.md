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

Every proxied request passes through a six-stage pipeline:

### 1. Authentication

All requests (except `GET /metadata`) require a valid Bearer token. The token is validated against Keycloak's JWKS endpoint. If validation fails, the proxy returns `401`.

### 2. Operation Policy

Some requests are refused whatever the token's scopes say, and regardless of `SCOPE_ENFORCEMENT_MODE`: no SMART grant covers them.

| Request | Result |
|---|---|
| Server administration operations: `$expunge`, `$reindex`, `$reindex-terminology`, `$perform-reindexing-pass`, `$mark-all-resources-for-reindexing`, `$get-resource-counts`, `$trigger-subscription`, the HAPI merge and replace-references operations, and code system uploads | `403` |
| `$export` and `$export-poll-status` without a `system/` scope | `403`. Bulk Data export is for SMART Backend Services. |
| `DELETE` with `_expunge` or `_cascade` | `403` |

Purging data is still possible for the one case a patient is entitled to it: see [Record Erasure](#record-erasure).

### 3. Consent & IAL Enforcement

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

### 4. SMART Scope Enforcement

When enabled (`SCOPE_ENFORCEMENT_MODE=enforce`), validates that the token's scopes grant permission for the requested operation.

- Supports SMART v1 format (`patient/Observation.read`) and v2 format (`patient/Observation.cruds`)
- Validates resource type and HTTP method against granted scopes
- Wildcard scopes (`patient/*.read`) match any resource type
- Returns `403` if the requested operation exceeds granted scopes

### 5. Role-Based Data Isolation

When enabled (`ROLE_BASED_FILTERING_MODE=enforce`), confines a request to one patient's FHIR compartment. This is the only stage that decides **which** patient may be read; scope enforcement checks resource types, and consent checks who may receive data.

Two rules, in order:

**A `patient/`-scoped grant is confined to one patient**, whoever the user is -- per SMART, "if the app has any patient-level scopes, they will be scoped to Patient 123". The patient is resolved the same way consent resolves it: `patient` claim, then the launch context captured at token exchange, then `fhirUser` when it names a `Patient`. A token holding `patient/` scopes with none of those resolving is refused, rather than widened to the whole server.

**A user who IS a patient** (`fhirUser: Patient/…`) sees only their own data.

Either way the compartment is applied as:

| Request | Result |
|---|---|
| `GET Patient?…` | `_id={ownId}` injected |
| `GET Patient/{other}` | `403` |
| `GET Observation` (any `PATIENT_SCOPED_RESOURCES` type) | `patient=Patient/{ownId}` injected |
| `GET Observation/{id}` | ownership verified upstream; `403` if the resource is not the patient's |

A user with only `user/`-scoped access and a non-Patient `fhirUser` -- a practitioner -- is **not** compartment-filtered here. Their access is governed by consent instead.

> **Not yet implemented:** narrowing a practitioner to the patients assigned to them via `generalPractitioner`. There are no `generalPractitioner` links in the system yet and the proxy performs no such lookup, so nothing here bounds a practitioner to an assigned panel. Until it exists, **consent is the only thing limiting which patients a practitioner can reach** -- which makes actor matching (above) load-bearing rather than advisory.

### 6. Capability-Aware Normalization

The proxy fetches and caches each upstream server's `CapabilityStatement` to enable intelligent request handling.

#### Strict Mode (per-server opt-in)

When `strictCapabilities` is enabled on a FHIR server:

- **Interaction checks** -- rejects unsupported CRUD operations with `405`
- **History checks** -- rejects `_history` requests if the server doesn't declare history support
- **Operation checks** -- rejects `$operation` calls not declared in the CapabilityStatement
- **PATCH format checks** -- rejects PATCH with unsupported content types with `415`

#### Search Parameter Normalization (always active)

Regardless of strict mode, the proxy strips search parameters and `_include`/`_revinclude` values not declared by the upstream server. This prevents `400` errors from servers that reject unknown parameters. Stripped parameters are listed in the `x-proxy-stripped-params` response header.

## Record Erasure

`POST [base]/[type]/[id]/$erase` permanently removes one record the signed-in patient created, together with its history. The proxy answers it rather than forwarding it, and the upstream server must support `$expunge`.

It runs after consent, tenant and scope checks, and the scope check treats it as a delete, so the token needs `d` (or `write`) on the resource type. The proxy then refuses with an `OperationOutcome` unless all of these hold:

| Check | Refusal |
|---|---|
| The user is the patient (`fhirUser: Patient/…`), and any patient context names the same patient | `403` |
| Every version of the record belongs to that patient (`subject` or `patient`) | `403` |
| No version has `verificationStatus` `confirmed`, and no version names a Practitioner, PractitionerRole or Organization as asserter, recorder, performer, requester, author or attester | `409` |
| No Provenance about the record has such an agent | `409` |
| Nothing but Provenance references the record | `409`, naming the referencing resources |
| The upstream server advertises `$expunge` | `501` |

A record a clinician attested stays: mark it `entered-in-error` instead, which keeps the original recognisable as medical record law requires. The `Patient` resource itself cannot be erased this way.

When the checks pass, a Provenance about this record alone is deleted and one about several records loses only this target; both are expunged. Then the record is deleted and expunged, including earlier versions. The proxy logs the erasure (reference and subject, no content) and answers `200`.

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
| `CONSENT_MODE` | Consent enforcement mode: `disabled`, `audit-only`, `enforce`; only applies when `CONSENT_ENABLED=true` | `audit-only` |
| `CONSENT_ENABLED` | Enable consent checks | `false` |
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
| `SCOPE_ENFORCEMENT_MODE` | Scope enforcement: `disabled`, `audit-only`, `enforce` | `enforce` |
| `ROLE_BASED_FILTERING_MODE` | Role-based filtering: `disabled`, `audit-only`, `enforce` | `audit-only` |
| `PATIENT_SCOPED_RESOURCES` | Resource types subject to patient-scoped filtering | `Observation,Condition,...` |
| `SMART_CONFIG_CACHE_TTL` | SMART configuration cache TTL (ms) | `300000` |
