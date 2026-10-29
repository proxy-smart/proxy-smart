// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// A Person's linked identities are offered regardless of which account signed in; do not add a per-party filter.

import { isStandaloneLaunch, parseScopes } from './smart-scopes'

/** No PractitionerRole: R4 `Person.link.target` cannot reference one. */
export const IDENTITY_TYPES = ['Patient', 'Practitioner', 'RelatedPerson'] as const

export type IdentityType = (typeof IDENTITY_TYPES)[number]

export interface IdentityCandidate {
  /** e.g. `Practitioner/123`, carried verbatim in the token */
  reference: string
  resourceType: IdentityType
  display?: string
}

export interface LaunchShape {
  /** An EHR launch code already named a patient. */
  patientContextEstablished?: boolean
  ehrLaunch?: boolean
}

export type IdentityChoice =
  | { action: 'none' }
  | { action: 'resolved'; identity: IdentityCandidate }
  | { action: 'choose'; candidates: IdentityCandidate[] }

/** Not `canReturnPatient`: that is also true for a bare EHR `launch`, where the patient is somebody else. */
export function candidatesForScopes(
  candidates: readonly IdentityCandidate[],
  scope: string | undefined,
  shape: LaunchShape = {},
): IdentityCandidate[] {
  // Before scopes: an EHR-launched app sets patient scopes too.
  if (shape.ehrLaunch) {
    const practitioners = candidates.filter((c) => c.resourceType === 'Practitioner')
    if (practitioners.length > 0) return practitioners
    return [...candidates]
  }

  if (!isStandaloneLaunch(parseScopes(scope), !!shape.patientContextEstablished)) return [...candidates]
  const patients = candidates.filter((c) => c.resourceType === 'Patient')
  return patients.length > 0 ? patients : [...candidates]
}

export function chooseIdentity(
  candidates: readonly IdentityCandidate[],
  scope: string | undefined,
  shape: LaunchShape = {},
): IdentityChoice {
  const usable = candidatesForScopes(candidates, scope, shape)
  const [first] = usable
  if (!first) return { action: 'none' }
  if (usable.length === 1) return { action: 'resolved', identity: first }
  return { action: 'choose', candidates: usable }
}

/** Membership in the offer IS the authorization: the POST is attacker-controlled. */
export function isOfferedIdentity(reference: string, offered: readonly string[]): boolean {
  return offered.includes(reference)
}
