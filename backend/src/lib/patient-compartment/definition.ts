// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// FHIR R4 Patient CompartmentDefinition: https://hl7.org/fhir/R4/compartmentdefinition-patient.html

import { literalReferenceTarget } from '../fhir-reference'
import { isRecord } from '../type-guards'

const PATIENT = 'Patient'

export interface CompartmentMembership {
  /** The search parameter that narrows a search of this type to one patient. */
  param: string
  /** The elements that parameter searches: a resource belongs to the patient through these. */
  member: readonly string[]
  /** Every element the CompartmentDefinition names for this type. */
  elements: readonly string[]
}

/** Per type, the `patient` search parameter where R4 defines one, else the definition's first. */
export const PATIENT_COMPARTMENT: ReadonlyMap<string, CompartmentMembership> = new Map(Object.entries({
  Account: { param: 'patient', member: ['subject'], elements: ['subject'] },
  AdverseEvent: { param: 'subject', member: ['subject'], elements: ['subject'] },
  AllergyIntolerance: { param: 'patient', member: ['patient'], elements: ['patient', 'recorder', 'asserter'] },
  Appointment: { param: 'patient', member: ['participant.actor'], elements: ['participant.actor'] },
  AppointmentResponse: { param: 'patient', member: ['actor'], elements: ['actor'] },
  AuditEvent: { param: 'patient', member: ['agent.who', 'entity.what'], elements: ['agent.who', 'entity.what'] },
  Basic: { param: 'patient', member: ['subject'], elements: ['subject', 'author'] },
  BodyStructure: { param: 'patient', member: ['patient'], elements: ['patient'] },
  CarePlan: { param: 'patient', member: ['subject'], elements: ['subject', 'activity.detail.performer'] },
  CareTeam: { param: 'patient', member: ['subject'], elements: ['subject', 'participant.member'] },
  ChargeItem: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Claim: { param: 'patient', member: ['patient'], elements: ['patient', 'payee.party'] },
  ClaimResponse: { param: 'patient', member: ['patient'], elements: ['patient'] },
  ClinicalImpression: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Communication: { param: 'patient', member: ['subject'], elements: ['subject', 'sender', 'recipient'] },
  CommunicationRequest: { param: 'patient', member: ['subject'], elements: ['subject', 'sender', 'recipient', 'requester'] },
  Composition: { param: 'patient', member: ['subject'], elements: ['subject', 'author', 'attester.party'] },
  Condition: { param: 'patient', member: ['subject'], elements: ['subject', 'asserter'] },
  Consent: { param: 'patient', member: ['patient'], elements: ['patient'] },
  Coverage: { param: 'patient', member: ['beneficiary'], elements: ['policyHolder', 'subscriber', 'beneficiary', 'payor'] },
  CoverageEligibilityRequest: { param: 'patient', member: ['patient'], elements: ['patient'] },
  CoverageEligibilityResponse: { param: 'patient', member: ['patient'], elements: ['patient'] },
  DetectedIssue: { param: 'patient', member: ['patient'], elements: ['patient'] },
  DeviceRequest: { param: 'patient', member: ['subject'], elements: ['subject', 'performer'] },
  DeviceUseStatement: { param: 'patient', member: ['subject'], elements: ['subject'] },
  DiagnosticReport: { param: 'patient', member: ['subject'], elements: ['subject'] },
  DocumentManifest: { param: 'patient', member: ['subject'], elements: ['subject', 'author', 'recipient'] },
  DocumentReference: { param: 'patient', member: ['subject'], elements: ['subject', 'author'] },
  Encounter: { param: 'patient', member: ['subject'], elements: ['subject'] },
  EnrollmentRequest: { param: 'patient', member: ['candidate'], elements: ['candidate'] },
  EpisodeOfCare: { param: 'patient', member: ['patient'], elements: ['patient'] },
  ExplanationOfBenefit: { param: 'patient', member: ['patient'], elements: ['patient', 'payee.party'] },
  FamilyMemberHistory: { param: 'patient', member: ['patient'], elements: ['patient'] },
  Flag: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Goal: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Group: { param: 'member', member: ['member.entity'], elements: ['member.entity'] },
  ImagingStudy: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Immunization: { param: 'patient', member: ['patient'], elements: ['patient'] },
  ImmunizationEvaluation: { param: 'patient', member: ['patient'], elements: ['patient'] },
  ImmunizationRecommendation: { param: 'patient', member: ['patient'], elements: ['patient'] },
  Invoice: { param: 'patient', member: ['subject'], elements: ['subject', 'recipient'] },
  List: { param: 'patient', member: ['subject'], elements: ['subject', 'source'] },
  MeasureReport: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Media: { param: 'patient', member: ['subject'], elements: ['subject'] },
  MedicationAdministration: { param: 'patient', member: ['subject'], elements: ['subject', 'performer.actor'] },
  MedicationDispense: { param: 'patient', member: ['subject'], elements: ['subject', 'receiver'] },
  MedicationRequest: { param: 'patient', member: ['subject'], elements: ['subject'] },
  MedicationStatement: { param: 'patient', member: ['subject'], elements: ['subject'] },
  MolecularSequence: { param: 'patient', member: ['patient'], elements: ['patient'] },
  NutritionOrder: { param: 'patient', member: ['patient'], elements: ['patient'] },
  Observation: { param: 'patient', member: ['subject'], elements: ['subject', 'performer'] },
  Patient: { param: '_id', member: [], elements: ['link.other'] },
  Person: { param: 'patient', member: ['link.target'], elements: ['link.target'] },
  Procedure: { param: 'patient', member: ['subject'], elements: ['subject', 'performer.actor'] },
  Provenance: { param: 'patient', member: ['target'], elements: ['target'] },
  QuestionnaireResponse: { param: 'patient', member: ['subject'], elements: ['subject', 'author'] },
  RelatedPerson: { param: 'patient', member: ['patient'], elements: ['patient'] },
  RequestGroup: { param: 'patient', member: ['subject'], elements: ['subject', 'action.participant'] },
  ResearchSubject: { param: 'patient', member: ['individual'], elements: ['individual'] },
  RiskAssessment: { param: 'patient', member: ['subject'], elements: ['subject'] },
  Schedule: { param: 'actor', member: ['actor'], elements: ['actor'] },
  ServiceRequest: { param: 'patient', member: ['subject'], elements: ['subject', 'performer'] },
  Specimen: { param: 'patient', member: ['subject'], elements: ['subject'] },
  SupplyDelivery: { param: 'patient', member: ['patient'], elements: ['patient'] },
  SupplyRequest: { param: 'subject', member: ['deliverTo'], elements: ['deliverTo'] },
  VisionPrescription: { param: 'patient', member: ['patient'], elements: ['patient'] },
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

/** The search parameter and value that narrow a search of this type to the patient; null outside the compartment. */
export function compartmentSearchParam(resourceType: string, patientId: string): [string, string] | null {
  const membership = PATIENT_COMPARTMENT.get(resourceType)
  if (!membership) return null
  return [membership.param, membership.param === '_id' ? patientId : `${PATIENT}/${patientId}`]
}

/** Top-level elements a write must not change to stay in the compartment it was checked against. */
export function compartmentRootElements(resourceType: string): ReadonlySet<string> {
  const paths = PATIENT_COMPARTMENT.get(resourceType)?.elements ?? []
  return new Set(['id', ...paths.map((path) => path.split('.')[0])])
}

/**
 * Belongs to this patient through the type's search parameter, so a search finds it again, and
 * references no other patient through any compartment element. A Patient belongs by id alone.
 */
export function patientCompartmentVerdict(resource: Record<string, unknown>, patientId: string, serverUrl: string): CompartmentVerdict {
  const type = resource.resourceType
  if (typeof type !== 'string') return { member: false, reason: 'The resource has no resourceType.' }
  const membership = PATIENT_COMPARTMENT.get(type)
  if (!membership) return { member: false, reason: `${type} is not in the Patient compartment, so a patient-confined grant cannot write it.` }

  let belongs = type === PATIENT && resource.id === patientId
  for (const path of membership.elements) {
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
      if (membership.member.includes(path)) belongs = true
    }
  }
  if (belongs) return { member: true }
  const through = membership.member.map((path) => `${type}.${path}`).join(' or ')
  return { member: false, reason: `The ${type} does not belong to Patient/${patientId}${through ? ` through ${through}` : ''}.` }
}
