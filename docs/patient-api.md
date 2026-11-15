# Patient API

The Patient API provides SMART-authenticated endpoints for patient-facing applications. They take a SMART access token rather than an admin token and are separate from the admin API. Most expect the patient's own token; the consent notification expects a practitioner's, and the share-link routes accept the opaque session token a link's manifest hands out.

## Base Path

All patient API endpoints are under `/api/`.

## SMART Health Links

Spec-compliant SHL creation and manifest serving, for sharing a record by QR code. See the [SHL specification](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html).

| Route | Caller | Purpose |
|-------|--------|---------|
| `POST /api/shl/` | Patient token | Mint a link. `expiresInMinutes` defaults to 60 and is capped at 4320; a `studyInstanceUID` must belong to the patient's own record. |
| `POST /api/shl/{key}/{id}` | Anyone holding the link | The manifest. Returns the encrypted access document for the session. |
| `POST /api/shl/attest` | Session token | The recipient's name and drawn signature, required once before a write-enabled share accepts any write. It records attribution only, since a share link stays a bearer credential. |
| `/api/shl/fhir`, `/api/shl/fhir/*` | Session token | FHIR through the share, confined to the shared patient, including `_getpages` paging. |
| `/api/shl/dicomweb/*` | Session token | DICOMweb through the share; a write-enabled share also takes STOW-RS uploads once `attest` has been signed. |

No real token leaves the server. The manifest carries an opaque session token whose audience points back at `/api/shl/fhir`, so a recipient calls this proxy and the backend fetches from the FHIR server with a service account. Every manifest fetch re-derives what the link asserts — how long it is good for, and what the share covers — from the share as it stands now, so correcting the rule behind a share also corrects links already in circulation, and a revoked consent makes the session inert.

## Consent Notification

**`POST /api/consent/notify-access-request`**

Notifies a patient by email that a practitioner has requested access to their data. The caller's token must carry a `fhirUser` that is a `Practitioner` or `PractitionerRole`; any other caller gets `403`. The address is resolved from the identity provider rather than taken from the request, and the route answers `503` when the deployment has no email configured.

## Data Access Log

**`GET /api/consent/monitoring/access-log`**

Who read or was refused the patient's records, and when: the consent decisions the proxy made for that patient. Only the patient may read it: the token's `fhirUser` must be the Patient, or a Person linked to it, and the log is that patient's, never one named in the request. A `patient` claim or launch context alone does not qualify, since a practitioner's EHR launch carries one too, so a practitioner or a token without `fhirUser` gets `403`. Request the `fhirUser` scope.

Optional query parameters: `limit` (default 200, at most 1000), `decision` (`permit` or `deny`), `resourceType` and `since` (an ISO date). Each entry carries `id`, `timestamp`, `decision`, `clientId`, `username`, `resourceType`, `method` and `reason`. Administrators read any patient's full log at `/admin/monitoring/consent/patients/{patientId}/access-log`.
