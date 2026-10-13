// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// FHIR R4 Patient CompartmentDefinition: https://hl7.org/fhir/R4/compartmentdefinition-patient.html

import { literalReferenceTarget } from '../fhir-reference'
import { isRecord } from '../type-guards'

const PATIENT = 'Patient'

/** Per resource type, the elements (search parameter expressions) that put a resource in a Patient's compartment. */
export const PATIENT_COMPARTMENT: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  Account: ['subject'],
  AdverseEvent: ['subject'],
  AllergyIntolerance: ['patient', 'recorder', 'asserter'],
  Appointment: ['participant.actor'],
  AppointmentResponse: ['actor'],
  AuditEvent: ['agent.who', 'entity.what'],
  Basic: ['subject', 'author'],
  BodyStructure: ['patient'],
  CarePlan: ['subject', 'activity.detail.performer'],
  CareTeam: ['subject', 'participant.member'],
  ChargeItem: ['subject'],
  Claim: ['patient', 'payee.party'],
  ClaimResponse: ['patient'],
  ClinicalImpression: ['subject'],
  Communication: ['subject', 'sender', 'recipient'],
  CommunicationRequest: ['subject', 'sender', 'recipient', 'requester'],
  Composition: ['subject', 'author', 'attester.party'],
  Condition: ['subject', 'asserter'],
  Consent: ['patient'],
  Coverage: ['policyHolder', 'subscriber', 'beneficiary', 'payor'],
  CoverageEligibilityRequest: ['patient'],
  CoverageEligibilityResponse: ['patient'],
  DetectedIssue: ['patient'],
  DeviceRequest: ['subject', 'performer'],
  DeviceUseStatement: ['subject'],
  DiagnosticReport: ['subject'],
  DocumentManifest: ['subject', 'author', 'recipient'],
  DocumentReference: ['subject', 'author'],
  Encounter: ['subject'],
  EnrollmentRequest: ['candidate'],
  EpisodeOfCare: ['patient'],
  ExplanationOfBenefit: ['patient', 'payee.party'],
  FamilyMemberHistory: ['patient'],
  Flag: ['subject'],
  Goal: ['subject'],
  Group: ['member.entity'],
  ImagingStudy: ['subject'],
  Immunization: ['patient'],
  ImmunizationEvaluation: ['patient'],
  ImmunizationRecommendation: ['patient'],
  Invoice: ['subject', 'recipient'],
  List: ['subject', 'source'],
  MeasureReport: ['subject'],
  Media: ['subject'],
  MedicationAdministration: ['subject', 'performer.actor'],
  MedicationDispense: ['subject', 'receiver'],
  MedicationRequest: ['subject'],
  MedicationStatement: ['subject'],
  MolecularSequence: ['patient'],
  NutritionOrder: ['patient'],
  Observation: ['subject', 'performer'],
  Patient: ['link.other'],
  Person: ['link.target'],
  Procedure: ['subject', 'performer.actor'],
  Provenance: ['target'],
  QuestionnaireResponse: ['subject', 'author'],
  RelatedPerson: ['patient'],
  RequestGroup: ['subject', 'action.participant'],
  ResearchSubject: ['individual'],
  RiskAssessment: ['subject'],
  Schedule: ['actor'],
  ServiceRequest: ['subject', 'performer'],
  Specimen: ['subject'],
  SupplyDelivery: ['patient'],
  SupplyRequest: ['deliverTo'],
  VisionPrescription: ['patient'],
}))

export type CompartmentVerdict = { member: true } | { member: false; reason: string }

function valuesAt(resource: Record<string, unknown>, path: string): unknown[] {
  let current: unknown[] = [resource]
  for (const step of path.split('.')) {
    current = current.flatMap((value) => {
      if (!isRecord(value)) return []
      const next = value[step]
      if (Array.isArray(next)) return next
      return next === undefined ? [] : [next]
    })
  }
  return current
}

/** Top-level elements a write must not change to stay in the compartment it was checked against. */
export function compartmentRootElements(resourceType: string): ReadonlySet<string> {
  const paths = PATIENT_COMPARTMENT.get(resourceType) ?? []
  return new Set(['id', ...paths.map((path) => path.split('.')[0])])
}

/**
 * In this patient's compartment and no other's. A Patient belongs to its own compartment by id
 * alone: its links put it in another patient's compartment, never the other way round.
 */
export function patientCompartmentVerdict(resource: Record<string, unknown>, patientId: string, serverUrl: string): CompartmentVerdict {
  const type = resource.resourceType
  if (typeof type !== 'string') return { member: false, reason: 'The resource has no resourceType.' }
  const paths = PATIENT_COMPARTMENT.get(type)
  if (!paths) return { member: false, reason: `${type} is not in the Patient compartment, so a patient-confined grant cannot write it.` }

  let referencesPatient = type === PATIENT && resource.id === patientId
  for (const path of paths) {
    for (const value of valuesAt(resource, path)) {
      if (!isRecord(value) || value.reference === undefined) continue
      const target = typeof value.reference === 'string' ? literalReferenceTarget(value.reference, serverUrl) : null
      if (!target) {
        return { member: false, reason: `${type}.${path} holds a reference that cannot be resolved to a resource on this server.` }
      }
      if (target.type !== PATIENT) continue
      if (!target.local || target.id !== patientId) {
        return { member: false, reason: `${type}.${path} refers to a patient other than Patient/${patientId}.` }
      }
      if (type !== PATIENT) referencesPatient = true
    }
  }
  return referencesPatient
    ? { member: true }
    : { member: false, reason: `The ${type} does not belong to Patient/${patientId}.` }
}
