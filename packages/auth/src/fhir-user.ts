/**
 * @proxy-smart/auth — FHIR User Utilities
 *
 * Helpers for working with fhirUser references:
 *   - Extract patient ID from a fhirUser reference
 *   - Convert relative references to absolute URLs
 *   - Detect resource type from a fhirUser string
 */

/** Extract patient ID from a fhirUser reference (e.g., "Patient/123" → "123") */
export function extractPatientFromFhirUser(fhirUser: string): string | null {
  const match = fhirUser.match(/Patient\/([^/]+)$/)
  return match ? match[1] : null
}

/** Extract the resource type from a fhirUser reference */
export function getFhirUserResourceType(fhirUser: string): string | null {
  // Handle absolute URLs: https://fhir.example.com/Patient/123
  const absoluteMatch = fhirUser.match(/\/(Patient|PractitionerRole|Practitioner|RelatedPerson|Person)\/[^/]+$/)
  if (absoluteMatch) return absoluteMatch[1]

  // Handle relative references: Patient/123
  const relativeMatch = fhirUser.match(/^(Patient|PractitionerRole|Practitioner|RelatedPerson|Person)\//)
  return relativeMatch ? relativeMatch[1] : null
}

/** Check if a fhirUser reference is already an absolute URL */
export function isAbsoluteUrl(fhirUser: string): boolean {
  return fhirUser.startsWith('http://') || fhirUser.startsWith('https://')
}

/**
 * Convert a relative fhirUser reference to an absolute URL.
 *
 * @param fhirUser - Relative reference (e.g., "Practitioner/123")
 * @param fhirBaseUrl - FHIR server base URL (e.g., "https://proxy.example.com/proxy-smart-backend/default/R4")
 * @returns Absolute URL or the original value if already absolute
 */
export function toAbsoluteFhirUser(fhirUser: string, fhirBaseUrl: string): string {
  if (isAbsoluteUrl(fhirUser)) return fhirUser
  return `${fhirBaseUrl}/${fhirUser}`
}
