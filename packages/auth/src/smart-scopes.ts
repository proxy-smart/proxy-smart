// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

const LAUNCH_SCOPES = new Set(['launch', 'launch/patient', 'launch/encounter'])

/**
 * SMART App Launch 2.2: a `patient/` scope SHALL get a patient in context; we infer `launch/patient`.
 * Looser than SMART_V2_SCOPE_RE on ops, and a `?param` constraint stays patient-restricted.
 */
export const PATIENT_COMPARTMENT_SCOPE_RE = /^patient\/[\w*]+\.[\w*]+(\?.*)?$/

export function hasPatientCompartmentScope(scopes: Set<string>): boolean {
  for (const s of scopes) {
    if (PATIENT_COMPARTMENT_SCOPE_RE.test(s)) return true
  }
  return false
}

/** A FHIR Resource scope at user level, e.g. `user/*.rs`: whatever the signed-in user may access. */
export const USER_LEVEL_SCOPE_RE = /^user\/[\w*]+\.[\w*]+(\?.*)?$/

export function isSystemScope(scope: string): boolean {
  return scope.startsWith('system/')
}

export function hasSystemScope(scopes: Iterable<string>): boolean {
  for (const s of scopes) {
    if (isSystemScope(s)) return true
  }
  return false
}

export function hasUserLevelScope(scopes: Set<string>): boolean {
  for (const s of scopes) {
    if (USER_LEVEL_SCOPE_RE.test(s)) return true
  }
  return false
}

export function parseScopes(scope: string | undefined | null): Set<string> {
  return new Set((scope || '').split(' ').filter(Boolean))
}

export function parseTokenScopes(payload: { scope?: unknown }): Set<string> {
  return parseScopes(typeof payload.scope === 'string' ? payload.scope : undefined)
}

/** Includes `patient/` resource scopes: same context obligation as a launch scope. */
export function isSmartLaunch(scopes: Set<string>): boolean {
  for (const s of LAUNCH_SCOPES) {
    if (scopes.has(s)) return true
  }
  return hasPatientCompartmentScope(scopes)
}

const RESOURCE_SCOPE_RE = /^(patient|user|system)\/[\w*]+\.[\w*]+(\?.*)?$/

/** Any SMART launch or resource scope: the request is for a FHIR server, so SMART requires `aud`. */
export function isSmartResourceRequest(scopes: Set<string>): boolean {
  for (const s of scopes) {
    if (LAUNCH_SCOPES.has(s) || RESOURCE_SCOPE_RE.test(s)) return true
  }
  return false
}

/** A patient has to be in context: `launch/patient` asks for one and a `patient/` scope obliges one. */
export function requiresPatientContext(scopes: Set<string>): boolean {
  return scopes.has('launch/patient') || hasPatientCompartmentScope(scopes)
}

/** Patient context required but no EHR launch code supplies it, so the patient picker must. */
export function isStandaloneLaunch(scopes: Set<string>, hasLaunchCode: boolean): boolean {
  return requiresPatientContext(scopes) && !hasLaunchCode
}

/** Standalone `launch/encounter`: the proxy has to establish the encounter, since no EHR supplies it. */
export function isStandaloneEncounterLaunch(scopes: Set<string>, hasLaunchCode: boolean): boolean {
  return scopes.has('launch/encounter') && !hasLaunchCode
}

/** A `patient/` grant counts: the app needs the patient to stay inside its own compartment. */
export function canReturnPatient(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('launch/patient')
    || grantedScopes.has('launch')
    || hasPatientCompartmentScope(grantedScopes)
}

export function canReturnEncounter(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('launch/encounter') || grantedScopes.has('launch')
}

/** SMART 2.2: fhirUser is returned for a grant of `openid` together with `fhirUser`. */
export function canReturnFhirUser(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('fhirUser') && grantedScopes.has('openid')
}

/** Ops: a 1-5 char subset of [cruds] (v2) or v1 "read"/"write". */
export const SMART_V2_SCOPE_RE = /^(user|patient|system)\/([\w*]+)\.([cruds]{1,5}|read|write)$/

/**
 * "user/Patient.read" → "user/*.read"; non-v2 scopes pass through.
 *
 * @deprecated Unused by the authorize interceptor since Keycloak gets granular scopes from the admin API.
 */
export function expandScopesToWildcards(scope: string | undefined): string {
  if (!scope) return ''
  const expanded = Array.from(parseScopes(scope)).map((s: string) => {
    const match = s.match(SMART_V2_SCOPE_RE)
    if (!match) return s
    const [, compartment, , ops] = match
    return `${compartment}/*.${ops}`
  })
  return expanded.filter((s: string, i: number, arr: string[]) => arr.indexOf(s) === i).join(' ')
}

/** SMART v2 delegation: user/Patient.read is granted by user/*.read, plus v1/v2 ops aliases. */
export function isScopeGranted(requested: string, granted: Set<string>): boolean {
  if (granted.has(requested)) return true

  const match = requested.match(SMART_V2_SCOPE_RE)
  if (!match) return false

  const [, compartment, resourceType, ops] = match

  if (granted.has(`${compartment}/*.${ops}`)) return true

  if (granted.has(`${compartment}/${resourceType}.*`)) return true
  if (granted.has(`${compartment}/*.*`)) return true

  if (ops === 'r' || ops === 's' || ops === 'rs' || ops === 'read') {
    if (granted.has(`${compartment}/*.read`)) return true
  }

  if (ops === 'r' || ops === 's') {
    if (granted.has(`${compartment}/*.rs`)) return true
  }

  if (ops === 'r' || ops === 'read') {
    if (granted.has(`${compartment}/*.crud`) || granted.has(`${compartment}/*.cruds`)) return true
  }

  if (/^[cud]+$/.test(ops) || ops === 'write') {
    if (granted.has(`${compartment}/*.write`)) return true
  }

  return false
}

/** Requested scopes that are granted (directly or via wildcard), plus granted non-v2 scopes. */
export function filterScopes(requested: string | undefined, granted: string | undefined): string {
  if (!requested) return granted || ''
  const requestedSet = parseScopes(requested)
  const grantedSet = parseScopes(granted)
  const finalScopes: string[] = []

  for (const s of requestedSet) {
    if (isScopeGranted(s, grantedSet)) {
      finalScopes.push(s)
    }
  }

  for (const s of grantedSet) {
    if (requestedSet.has(s)) continue

    if (!SMART_V2_SCOPE_RE.test(s)) {
      finalScopes.push(s)
    }
  }

  return finalScopes.join(' ')
}
