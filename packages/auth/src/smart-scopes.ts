// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * @proxy-smart/auth — SMART Scopes Utilities
 *
 * Pure functions for detecting and gating SMART on FHIR scopes.
 * No side effects, no dependencies.
 */

/** SMART launch scopes that trigger callback interception */
const LAUNCH_SCOPES = new Set(['launch', 'launch/patient', 'launch/encounter'])

/**
 * A FHIR Resource scope restricted to a single patient, e.g. `patient/Observation.rs`.
 *
 * SMART App Launch 2.2 puts an obligation on the authorization server for these,
 * in both "Apps that launch from the EHR" and "Standalone apps":
 *
 *   "If an application requests a FHIR Resource scope which is restricted to a
 *    single patient (e.g., patient/*.rs), and the authorization results in the
 *    EHR granting that scope, the EHR SHALL establish a patient in context."
 *
 *   "The EHR MAY refuse authorization requests including patient/ that do not
 *    also include a valid launch [/ launch/patient scope], or it MAY infer the
 *    launch/patient scope."
 *
 * We take the infer branch: a `patient/` scope is treated as implying
 * `launch/patient`, so the existing launch machinery (EHR launch context, or the
 * patient picker for standalone) establishes the context the SHALL requires.
 *
 * Deliberately looser than SMART_V2_SCOPE_RE on the operations part: this asks
 * "is this grant patient-restricted", not "is every character valid".
 */
export const PATIENT_COMPARTMENT_SCOPE_RE = /^patient\/[\w*]+\.[\w*]+$/

/** Whether any granted/requested scope is restricted to a single patient. */
export function hasPatientCompartmentScope(scopes: Set<string>): boolean {
  for (const s of scopes) {
    if (PATIENT_COMPARTMENT_SCOPE_RE.test(s)) return true
  }
  return false
}

/** A FHIR Resource scope at user level, e.g. `user/*.rs`: whatever the signed-in user may access. */
export const USER_LEVEL_SCOPE_RE = /^user\/[\w*]+\.[\w*]+$/

/** Whether any granted scope is a user-level resource scope. */
export function hasUserLevelScope(scopes: Set<string>): boolean {
  for (const s of scopes) {
    if (USER_LEVEL_SCOPE_RE.test(s)) return true
  }
  return false
}

/** Parse a space-separated scope string into a Set */
export function parseScopes(scope: string | undefined | null): Set<string> {
  return new Set((scope || '').split(' ').filter(Boolean))
}

export function parseTokenScopes(payload: { scope?: unknown }): Set<string> {
  return parseScopes(typeof payload.scope === 'string' ? payload.scope : undefined)
}

/**
 * Detect whether the requested scopes indicate a SMART launch flow.
 *
 * Includes patient-restricted resource scopes, because those carry the same
 * context obligation as an explicit launch scope — see
 * PATIENT_COMPARTMENT_SCOPE_RE.
 */
export function isSmartLaunch(scopes: Set<string>): boolean {
  for (const s of LAUNCH_SCOPES) {
    if (scopes.has(s)) return true
  }
  return hasPatientCompartmentScope(scopes)
}

/**
 * Detect standalone launch: patient context is required but no EHR launch code
 * supplies it, so the proxy must establish it (patient picker).
 */
export function isStandaloneLaunch(scopes: Set<string>, hasLaunchCode: boolean): boolean {
  return (scopes.has('launch/patient') || hasPatientCompartmentScope(scopes)) && !hasLaunchCode
}

/**
 * Check if the granted scopes allow returning patient context.
 *
 * A patient-restricted resource scope counts: the context established for it
 * has to reach the app, otherwise the app cannot stay inside the compartment
 * its own grant is limited to.
 */
export function canReturnPatient(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('launch/patient')
    || grantedScopes.has('launch')
    || hasPatientCompartmentScope(grantedScopes)
}

/** Check if the granted scopes allow returning encounter context */
export function canReturnEncounter(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('launch/encounter') || grantedScopes.has('launch')
}

/** Check if the granted scopes allow returning fhirUser */
export function canReturnFhirUser(grantedScopes: Set<string>): boolean {
  return grantedScopes.has('fhirUser') || grantedScopes.has('openid')
}

/** SMART v2 Scope regex for permission delegation (e.g. user/Patient.read)
 *  Ops group accepts: any 1-5 char subset of [cruds] (v2), or v1 "read"/"write".
 */
export const SMART_V2_SCOPE_RE = /^(user|patient|system)\/([\w*]+)\.([cruds]{1,5}|read|write)$/

/**
 * Expand granular SMART v2 scopes to their wildcard equivalents for forwarding to the IdP.
 * e.g. "user/Patient.read" → "user/*.read", "user/ImagingStudy.rs" → "user/*.rs"
 *
 * The IdP only has wildcards registered. We send wildcards upstream so it doesn't reject
 * the request, then restore the specific scopes in the token response.
 *
 * Non-SMART-v2 scopes (openid, fhirUser, launch, etc.) are passed through unchanged.
 *
 * @deprecated No longer used by the authorize interceptor — Keycloak now has granular
 * scopes auto-created by the admin API. Kept for backward compatibility.
 */
export function expandScopesToWildcards(scope: string | undefined): string {
  if (!scope) return ''
  const expanded = Array.from(parseScopes(scope)).map((s: string) => {
    const match = s.match(SMART_V2_SCOPE_RE)
    if (!match) return s
    const [, compartment, , ops] = match
    return `${compartment}/*.${ops}`
  })
  // Deduplicate — multiple granular scopes may collapse to the same wildcard
  return expanded.filter((s: string, i: number, arr: string[]) => arr.indexOf(s) === i).join(' ')
}

/**
 * Check if a specific requested scope is granted via a wildcard scope.
 * Implements SMART v2 scope delegation (e.g. user/Patient.read matches user/*.read)
 */
export function isScopeGranted(requested: string, granted: Set<string>): boolean {
  if (granted.has(requested)) return true

  const match = requested.match(SMART_V2_SCOPE_RE)
  if (!match) return false

  const [, compartment, resourceType, ops] = match

  // 1. Check for resource-type wildcard: user/*.read
  if (granted.has(`${compartment}/*.${ops}`)) return true

  // 2. Check for "all ops" wildcard: user/Patient.* or user/*.*
  if (granted.has(`${compartment}/${resourceType}.*`)) return true
  if (granted.has(`${compartment}/*.*`)) return true

  // 3. v1/v2 ops aliases — "upward" matching from specific to broader grants

  // v1 *.read covers all v2 read-type ops: .r, .s, .rs
  if (ops === 'r' || ops === 's' || ops === 'rs' || ops === 'read') {
    if (granted.has(`${compartment}/*.read`)) return true
  }

  // v2 *.rs covers individual read ops: .r, .s
  if (ops === 'r' || ops === 's') {
    if (granted.has(`${compartment}/*.rs`)) return true
  }

  // v2 *.crud/cruds cover .r (read is the 'r' in cruds)
  if (ops === 'r' || ops === 'read') {
    if (granted.has(`${compartment}/*.crud`) || granted.has(`${compartment}/*.cruds`)) return true
  }

  // v1 *.write covers all v2 write ops: any subset of [cud]
  if (/^[cud]+$/.test(ops) || ops === 'write') {
    if (granted.has(`${compartment}/*.write`)) return true
  }

  return false
}

/**
 * Filter scopes, ensuring that for SMART v2 scopes, only those that are granted
 * (either directly or via wildcards) are allowed.
 */
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

  // Preserve non-SMART-v2 scopes if they were granted
  for (const s of grantedSet) {
    // If it was already added because it was requested and matched, skip
    if (requestedSet.has(s)) continue
    
    // If it's a non-v2 scope (like openid, fhirUser, launch), preserve it
    if (!SMART_V2_SCOPE_RE.test(s)) {
      finalScopes.push(s)
    }
  }

  return finalScopes.join(' ')
}
