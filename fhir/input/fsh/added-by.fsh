Alias: $addedByPolicy = https://proxy-smart.com/fhir/policy/added-by
Alias: $fhirUserSystem = https://proxy-smart.com/fhir/sid/fhir-user
Alias: $uriSystem = urn:ietf:rfc:3986

Instance: ProxySmartFhirUserNamingSystem
InstanceOf: NamingSystem
Usage: #definition
Title: "Proxy Smart fhirUser Identifier System"
Description: "Identifies the signed-in user by their fhirUser reference, where FHIR allows no reference to its type, such as a Person at Provenance.agent.who."
* name = "ProxySmartFhirUser"
* status = #active
* kind = #identifier
* date = "2026-11-17"
* publisher = "Max Health Inc."
* responsible = "Max Health Inc."
* description = "The value is the fhirUser reference of a signed-in user, for example Person/123. Used when the user links no Patient or Practitioner that R4 lets the element reference."
* uniqueId.type = #uri
* uniqueId.value = $fhirUserSystem
* uniqueId.preferred = true

Invariant: added-by-creation
Description: "The first target is the record at the version it was created as."
Expression: "target.first().reference.contains('/_history/')"
Severity: #error

Invariant: added-by-agent
Description: "The agent names who added the record, by reference or by their fhirUser identifier."
Expression: "agent.who.reference.exists() or agent.who.identifier.where(system = 'https://proxy-smart.com/fhir/sid/fhir-user').exists()"
Severity: #error

Invariant: added-by-agent-type
Description: "A referenced agent is a Patient, Practitioner, PractitionerRole or RelatedPerson: R4 lets Provenance.agent.who reference no Person."
Expression: "agent.who.reference.all(matches('^(Patient|Practitioner|PractitionerRole|RelatedPerson)/[^/]+$'))"
Severity: #error

Profile: AddedByProvenance
Parent: Provenance
Id: added-by-provenance
Title: "Added-By Provenance"
Description: "Who added a record through Proxy Smart. The proxy writes one for every record a signed-in user creates and signs it, binding the user to that creation, so no client can claim or move the attribution. Erasure and authored-record exports trust the signature only."
* ^url = "https://proxy-smart.com/fhir/StructureDefinition/added-by-provenance"
* obeys added-by-creation and added-by-agent and added-by-agent-type
* target 1..2 MS
* target ^short = "The created record at its creation version, then the Patient whose chart it belongs to"
* recorded MS
* policy 1..1 MS
* policy = $addedByPolicy (exactly)
* activity 1..1 MS
* activity from AddedByActivityVS (required)
* agent 1..1 MS
* agent.type 1..1 MS
* agent.type from AddedByAgentTypeVS (required)
* agent.who MS
* agent.who only Reference(Patient or Practitioner or PractitionerRole or RelatedPerson)
* agent.who ^short = "The user, or the Patient or Practitioner a signed-in Person acts as"
* signature 1..1 MS
* signature.type from AddedBySignatureTypeVS (required)
* signature.when MS
* signature.who MS
* signature.who.identifier 1..1
* signature.who.identifier.system 1..1
* signature.who.identifier.system = $uriSystem (exactly)
* signature.who.identifier.value 1..1
* signature.sigFormat 1..1 MS
* signature.sigFormat = #application/jose (exactly)
* signature.data 1..1 MS
* signature.data ^short = "A JWS signed by the proxy: sub is the signed-in user, tgt the created record"
