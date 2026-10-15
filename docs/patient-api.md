# Patient API

The Patient API provides SMART-authenticated endpoints for patient-facing applications. These endpoints use the patient's own access token (obtained via SMART App Launch) and are separate from the admin API.

## Base Path

All patient API endpoints are under `/api/`.

## SMART Health Links

**`POST /api/shl/`** and the manifest, FHIR and DICOMweb routes beneath it.

Spec-compliant SHL creation and manifest serving, for sharing a record by QR code. See the [SHL specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html).

No real token leaves the server. The manifest carries an opaque session token whose audience points back at `/api/shl/fhir`, so a recipient calls this proxy and the backend fetches from the FHIR server with a service account. Every manifest fetch re-derives what the link asserts — how long it is good for, and what the share covers — from the share as it stands now, so correcting the rule behind a share also corrects links already in circulation, and a revoked consent makes the session inert.

## Consent Notification

**`POST /api/consent/notify-access-request`**

Notifies a patient by email that a practitioner has requested access to their data. The address is resolved from the identity provider rather than taken from the request.

## Data Access Log

**`GET /api/consent/monitoring/access-log`**

Who read or was refused the patient's records, and when: the consent decisions the proxy made for that patient. Only the patient may read it: the token's `fhirUser` must be the Patient, or a Person linked to it, and the log is that patient's, never one named in the request. A `patient` claim or launch context alone does not qualify, since a practitioner's EHR launch carries one too, so a practitioner or a token without `fhirUser` gets `403`. Request the `fhirUser` scope.

Optional query parameters: `limit` (default 200, at most 1000), `decision` (`permit` or `deny`), `resourceType` and `since` (an ISO date). Each entry carries `id`, `timestamp`, `decision`, `clientId`, `username`, `resourceType`, `method` and `reason`. Administrators read any patient's full log at `/admin/monitoring/consent/patients/{patientId}/access-log`.

## Document import and the scribe have moved

`POST /api/document-import/`, `POST /api/patient-scribe/` and `POST /admin/document-import/` were removed.

Turning a PDF or a free-text description into FHIR resources is not an authorization concern. Keeping it here meant this service also carried a PDF text extractor and the Java runtime it needed, and reached for an AI model — none of which an authenticating proxy has any reason to contain. Document import belongs to whichever service in a deployment owns clinical ingestion, and a self-hosted deployment that wants it needs to run one; this proxy no longer provides it.

What has not changed is where the resulting resources go. An importer only ever returned them for review; the portal still POSTs the ones a patient confirms through the FHIR proxy, which is what enforces scope, consent and audit.
