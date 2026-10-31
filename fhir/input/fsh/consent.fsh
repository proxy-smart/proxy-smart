Alias: $consentscope = http://terminology.hl7.org/CodeSystem/consentscope
// The SHL session identifier system, declared once: it is asserted by the
// NamingSystem below and again as the fixed value on the identifier slice, and
// those two must never disagree.
Alias: $shlSessionSystem = https://maxhealth.tech/fhir/shl-session

// ─────────────────────────────────────────────────────────────────────────────
// Terminology owned by this IG
//
// These are the only two canonical URLs Max Health mints for consent. Both were
// previously string literals in the proxy backend and again in the consent
// portal, defined nowhere and therefore unvalidatable — a typo in either copy
// silently broke SHL revocation, which matches shares on the identifier system.
// Defining them here makes the canonicals resolvable and lets the profile below
// enforce them.
//
// Note this CodeSystem covers only codes WE mint. A base MaxHealthConsent
// categorises with LOINC (57016-8, privacy policy acknowledgment), so
// MaxHealthConsent.category is deliberately left unbound.
// ─────────────────────────────────────────────────────────────────────────────

CodeSystem: MaxHealthConsentCategory
Id: maxhealth-consent-category
Title: "Max Health Consent Category"
Description: "Consent categories minted by Max Health, for kinds of consent that have no suitable standard code."
* ^url = "https://maxhealth.tech/fhir/consent-category"
* ^status = #draft
* ^caseSensitive = true
* ^content = #complete
* #smart-health-link "SMART Health Link share" "A patient-initiated share backed by a SMART Health Link (SHL). Marks the Consent so portals can surface shares distinctly and filter them out of the practitioner-consent list."

ValueSet: MaxHealthConsentCategoryVS
Id: maxhealth-consent-category-vs
Title: "Max Health Consent Category Value Set"
Description: "All consent categories minted by Max Health."
* ^url = "https://maxhealth.tech/fhir/ValueSet/consent-category"
* ^status = #draft
* include codes from system MaxHealthConsentCategory

// The identifier system tying a share Consent to its SHL session id. Declared as
// a NamingSystem because it identifies resources in another system (the proxy's
// SHL session store) rather than carrying codes.
Instance: MaxHealthShlSessionNamingSystem
InstanceOf: NamingSystem
Usage: #definition
Title: "Max Health SHL Session Identifier System"
Description: "Identifier system for SMART Health Link session ids, as carried on MaxHealthShareConsent.identifier."
* name = "MaxHealthShlSession"
* status = #draft
* kind = #identifier
* date = "2026-08-02"
* publisher = "Max Health Inc."
* responsible = "Max Health Inc."
* description = "Identifies a SMART Health Link session in the proxy's SHL session store. A MaxHealthShareConsent carries exactly one identifier from this system; the proxy matches on it to resolve and revoke the backing share."
* uniqueId.type = #uri
* uniqueId.value = $shlSessionSystem
* uniqueId.preferred = true

// ─────────────────────────────────────────────────────────────────────────────
// Consent — patient-privacy data-access consent
//
// The base profile the consent portal manages: which organization or app the
// patient has granted access to, over which data classes, for how long.
// Mirrors the model in maxhealth.tech/CONSENT_PORTAL.md.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Revocation instant
//
// R4 Consent has no element for when a permission ended: status says THAT it
// ended, and dateTime / provision.period must keep saying when it was granted,
// because that is the evidence the earlier processing was lawful. The consent
// portal has stamped this extension since revocation shipped, under a URL no IG
// declared; it is declared here with that URL pinned, so every Consent already
// revoked stays readable and maxhealth.tech's withdrawal writes the same thing.
// ─────────────────────────────────────────────────────────────────────────────

Extension: ConsentRevocation
Id: consent-revocation
Title: "Consent Revocation"
Description: "The instant a patient revoked or withdrew this consent. Set together with status = inactive; the grant's own dateTime and provision.period are left as they were."
* ^url = "https://maxhealth.tech/fhir/StructureDefinition/consent-revocation"
* ^status = #active
* ^experimental = false
* ^context[0].type = #element
* ^context[0].expression = "Consent"
* value[x] only instant
* value[x] 1..1

Invariant: mhc-provision-type
Description: "The root provision states no type; every nested provision states permit or deny (R4 Consent.provision.type: not permitted in root rule, required in all nested rules)."
Expression: "provision.type.empty() and provision.repeat(provision).all(type.exists())"
Severity: #error

Profile: MaxHealthConsent
Parent: Consent
Id: maxhealth-consent
Title: "Max Health Consent"
Description: "Patient-privacy consent governing which organizations or apps may access a patient's data, scoped by data class and time period. The root provision carries the conditions; nested provisions state permit or deny."

* obeys mhc-provision-type
* extension contains ConsentRevocation named revocation 0..1 MS
* status MS
* scope = $consentscope#patient-privacy
* category 1..* MS
* patient 1..1 MS
* dateTime MS
* provision MS
* provision.period MS
* provision.actor MS
* provision.actor.role MS
* provision.actor.reference MS
* provision.action MS
* provision.class MS
* provision.provision MS
* provision.provision.type MS

// ─────────────────────────────────────────────────────────────────────────────
// Share Consent — a SMART Health Link (SHL) modelled as a Consent
//
// A patient-initiated share IS a consent grant: the patient (performer) permits
// a recipient (provision.actor) to access a scoped set of resource classes
// until the link expires (provision.period.end == the SHL's expiresAt).
//
// Consent.identifier carries the SHL session id so the proxy can reconcile the
// Consent with its SHL session store (mint → active, revoke → inactive+delete).
// ─────────────────────────────────────────────────────────────────────────────

Invariant: mhc-share-permit
Description: "A share states its permit in nested provisions, and never denies."
Expression: "provision.provision.exists() and provision.repeat(provision).all(type = 'permit')"
Severity: #error

Profile: MaxHealthShareConsent
Parent: MaxHealthConsent
Id: maxhealth-share-consent
Title: "Max Health Share Consent (SMART Health Link)"
Description: "A patient-initiated data share represented as a Consent. Backs a SMART Health Link (SHL): a time-limited permit provision granting a recipient access to a scoped set of resources. The link's expiry is provision.period.end; the SHL session id is carried in Consent.identifier."

// The SHL session id — links this Consent to its row in the SHL session store.
// Sliced on system and fixed to the NamingSystem above: revocation resolves a
// share by matching this exact system, so a drifted value has to fail validation
// rather than silently stop matching. Exactly one, because one Consent mirrors
// one SHL session.
* identifier 1..* MS
* identifier ^slicing.discriminator[0].type = #value
* identifier ^slicing.discriminator[0].path = "system"
* identifier ^slicing.rules = #open
* identifier ^slicing.description = "Sliced on the identifier system so the SHL session id is required and validatable."
* identifier contains shlSession 1..1 MS
* identifier[shlSession].system 1..1
* identifier[shlSession].system = $shlSessionSystem (exactly)
* identifier[shlSession].value 1..1
* identifier[shlSession] ^short = "SHL session id"
* identifier[shlSession] ^definition = "The id of the SMART Health Link session this Consent mirrors, in the proxy's SHL session store."

// Marks the Consent as a share so portals can filter it out of the ordinary
// consent list. Inherited category stays open (a base consent uses LOINC), but a
// share must carry this one.
* category ^slicing.discriminator[0].type = #value
* category ^slicing.discriminator[0].path = "coding.system"
* category ^slicing.rules = #open
* category ^slicing.description = "Sliced so the SMART Health Link marker is required on every share."
* category contains shareMarker 1..1 MS
* category[shareMarker] = MaxHealthConsentCategory#smart-health-link (exactly)
* category[shareMarker] ^short = "SMART Health Link share marker"

// The patient who created the share.
* performer 1..1 MS
// A share only ever permits; it never denies.
* obeys mhc-provision-type and mhc-share-permit
// Every share expires — period.end maps to the SHL's expiresAt.
* provision.period 1..1 MS
* provision.period.end 1..1 MS
// Granted to any holder of the link (a bearer credential), carried as a single
// Information Recipient actor. Actual recipients/devices are NOT enumerated here
// — access is tracked out of band via the SHL session store + AuditEvent, which
// is where an access log belongs (Consent.provision.actor is the grantee, not a log).
* provision.actor 1..* MS
* provision.actor.role MS
// Resource classes the link exposes. Present only for scoped shares (e.g. a
// single ImagingStudy); a whole-patient share omits it (empty class = all),
// so this is optional rather than a fabricated type list.
* provision.class 0..* MS
