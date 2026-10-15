// The HL7 and LOINC codes written against this IG (proxy-smart, consent-app, dicom-viewer), one ValueSet
// per use, so consumers import typed concepts from @proxy-smart/consent-fhir. A new code goes here first.

Alias: $loinc = http://loinc.org
Alias: $v3-ActCode = http://terminology.hl7.org/CodeSystem/v3-ActCode
Alias: $v3-ParticipationType = http://terminology.hl7.org/CodeSystem/v3-ParticipationType
Alias: $consentaction = http://terminology.hl7.org/CodeSystem/consentaction
Alias: $audit-event-type = http://terminology.hl7.org/CodeSystem/audit-event-type
Alias: $restful-interaction = http://hl7.org/fhir/restful-interaction
Alias: $audit-entity-type = http://terminology.hl7.org/CodeSystem/audit-entity-type
Alias: $object-role = http://terminology.hl7.org/CodeSystem/object-role
Alias: $restful-security-service = http://terminology.hl7.org/CodeSystem/restful-security-service

ValueSet: ShareConsentScopeVS
Id: share-consent-scope-vs
Title: "Share Consent Scopes"
Description: "The scope of a SMART Health Link share Consent: a patient-privacy consent."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/share-consent-scope-vs"
* ^status = #active
* ^experimental = false
* $consentscope#patient-privacy "Privacy Consent"

ValueSet: ShareConsentDocumentCategoryVS
Id: share-consent-document-category-vs
Title: "Share Consent Document Categories"
Description: "The LOINC document category a share Consent carries beside its SMART Health Link marker."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/share-consent-document-category-vs"
* ^status = #active
* ^experimental = false
* $loinc#59284-0 "Consent Document"

ValueSet: ShareConsentPolicyRuleVS
Id: share-consent-policy-rule-vs
Title: "Share Consent Policy Rules"
Description: "The policy rule on a share Consent: an opt-in directive, which R4 invariant ppc-1 requires when no policy is referenced."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/share-consent-policy-rule-vs"
* ^status = #active
* ^experimental = false
* $v3-ActCode#OPTIN "opt-in"

ValueSet: ShareConsentActorRoleVS
Id: share-consent-actor-role-vs
Title: "Share Consent Actor Roles"
Description: "The role of the grantee on a share Consent: whoever holds the link receives the information."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/share-consent-actor-role-vs"
* ^status = #active
* ^experimental = false
* $v3-ParticipationType#IRCP "information recipient"

ValueSet: ShareConsentActionVS
Id: share-consent-action-vs
Title: "Share Consent Actions"
Description: "What a share permits: access always, and correction when the link allows uploads."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/share-consent-action-vs"
* ^status = #active
* ^experimental = false
* $consentaction#access "Access"
* $consentaction#correct "Access and Correct"

ValueSet: ShlAccessAuditTypeVS
Id: shl-access-audit-type-vs
Title: "SHL Access Audit Event Types"
Description: "The AuditEvent.type of a SMART Health Link open."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/shl-access-audit-type-vs"
* ^status = #active
* ^experimental = false
* $audit-event-type#rest "RESTful Operation"

ValueSet: ShlAccessAuditSubtypeVS
Id: shl-access-audit-subtype-vs
Title: "SHL Access Audit Event Subtypes"
Description: "The AuditEvent.subtype of a SMART Health Link open: a read."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/shl-access-audit-subtype-vs"
* ^status = #active
* ^experimental = false
* $restful-interaction#read "read"

ValueSet: ShlAccessAgentTypeVS
Id: shl-access-agent-type-vs
Title: "SHL Access Agent Types"
Description: "The AuditEvent.agent.type of whoever opened a SMART Health Link."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/shl-access-agent-type-vs"
* ^status = #active
* ^experimental = false
* $v3-ParticipationType#IRCP "information recipient"

ValueSet: ShlAccessEntityTypeVS
Id: shl-access-entity-type-vs
Title: "SHL Access Entity Types"
Description: "The AuditEvent.entity.type of a SMART Health Link open: the patient and the link itself."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/shl-access-entity-type-vs"
* ^status = #active
* ^experimental = false
* $audit-entity-type#1 "Person"
* $audit-entity-type#2 "System Object"

ValueSet: ShlAccessEntityRoleVS
Id: shl-access-entity-role-vs
Title: "SHL Access Entity Roles"
Description: "The AuditEvent.entity.role of the patient whose shared data was opened."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/shl-access-entity-role-vs"
* ^status = #active
* ^experimental = false
* $object-role#1 "Patient"

ValueSet: SmartSecurityServiceVS
Id: smart-security-service-vs
Title: "SMART Security Services"
Description: "The CapabilityStatement.rest.security.service the proxy advertises for itself and its App State endpoint."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/smart-security-service-vs"
* ^status = #active
* ^experimental = false
* $restful-security-service#SMART-on-FHIR "SMART-on-FHIR"

ValueSet: ConsentGrantDocumentCategoryVS
Id: consent-grant-document-category-vs
Title: "Consent Grant Document Categories"
Description: "The LOINC category of a MaxHealthConsent granting an organization or practitioner access."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/consent-grant-document-category-vs"
* ^status = #active
* ^experimental = false
* $loinc#57016-8 "Privacy policy acknowledgment Document"

ValueSet: ConsentGrantActorRoleVS
Id: consent-grant-actor-role-vs
Title: "Consent Grant Actor Roles"
Description: "The role of the organization or practitioner a MaxHealthConsent grants access to."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/consent-grant-actor-role-vs"
* ^status = #active
* ^experimental = false
* $v3-ParticipationType#PRCP "primary information recipient"

ValueSet: ConsentGrantActionVS
Id: consent-grant-action-vs
Title: "Consent Grant Actions"
Description: "What a MaxHealthConsent grant permits: access to the data, and disclosure of it."
* ^url = "https://maxhealth.tech/fhir/consent/ValueSet/consent-grant-action-vs"
* ^status = #active
* ^experimental = false
* $consentaction#access "Access"
* $consentaction#disclose "Disclose"
