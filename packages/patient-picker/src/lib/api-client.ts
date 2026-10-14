import { reportAuthError } from "@proxy-smart/shared-ui"
import { getPickerParams } from "./picker-params"
import type { Bundle, Encounter, FhirResource, Patient } from "fhir/r4"

export type { Patient, Encounter }

export type ResourceBundle = Bundle<FhirResource>

// ── Fetch Wrapper ───────────────────────────────────────────────────────────

/** Session and other auth errors go to shared-ui's auth-error bus, so the app shows one screen for them. */
async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    reportAuthError("Unable to reach the server. Check your connection and try again.")
    throw new Error("Network error")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    const message = body.error_description || body.error || `Unexpected error (HTTP ${res.status})`

    const isAuthError = res.status === 401
      || body.error === "session_expired"
      || body.error_description?.toLowerCase().includes("expired")

    if (isAuthError) {
      reportAuthError(message)
    }

    throw new Error(message)
  }

  return res.json()
}

/** A backend picker endpoint, keyed by the launch session this page was opened with. */
function sessionUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(path, window.location.origin)
  url.searchParams.set("session", getPickerParams()?.session ?? "")
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url.href
}

export function resourcesOfType<T extends FhirResource["resourceType"]>(
  bundle: ResourceBundle,
  resourceType: T,
): Extract<FhirResource, { resourceType: T }>[] {
  return (bundle.entry ?? []).flatMap((entry) => {
    const resource = entry.resource
    return resource && isResourceOfType(resource, resourceType) ? [resource] : []
  })
}

function isResourceOfType<T extends FhirResource["resourceType"]>(
  resource: FhirResource,
  resourceType: T,
): resource is Extract<FhirResource, { resourceType: T }> {
  return resource.resourceType === resourceType
}

// ── Patient Search API ──────────────────────────────────────────────────────

export async function searchPatients(query: string, count = 20): Promise<Patient[]> {
  const bundle = await apiFetch<ResourceBundle>(sessionUrl("/auth/patient-search", { name: query, _count: count }))
  return resourcesOfType(bundle, "Patient")
}

export async function listPatients(offset: number, count = 10): Promise<ResourceBundle> {
  return apiFetch<ResourceBundle>(sessionUrl("/auth/patient-search", { _count: count, _offset: offset, _sort: "family" }))
}

// ── Encounter Search API ────────────────────────────────────────────────────

/** The selected patient's encounters, newest first. The backend decides whose; nothing here names a patient. */
export async function listEncounters(): Promise<Encounter[]> {
  const bundle = await apiFetch<ResourceBundle>(sessionUrl("/auth/encounter-search"))
  return resourcesOfType(bundle, "Encounter")
}

// ── Brand Context API ─────────────────────────────────────────────────────

interface BrandContext {
  primaryColor: string | null
  accentColor: string | null
}

/** Best-effort brand colour for this launch; theming is optional, so a failure returns null. */
export async function fetchBrandContext(): Promise<BrandContext | null> {
  if (!getPickerParams()?.session) return null
  try {
    const res = await fetch(sessionUrl("/auth/brand-context"))
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Selection submissions ───────────────────────────────────────────────────

interface SelectionResult {
  redirect_url: string
}

async function submitSelection(path: string, fields: Record<string, string>): Promise<string> {
  const data = await apiFetch<SelectionResult>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  })
  return data.redirect_url
}

export function submitPatientSelection(session: string, code: string, patientId: string): Promise<string> {
  return submitSelection("/auth/patient-select", { session, code, patient: patientId })
}

/** `null` proceeds without an encounter, which the backend accepts only when it offered none. */
export function submitEncounterSelection(session: string, code: string, encounterId: string | null): Promise<string> {
  return submitSelection("/auth/encounter-select", { session, code, ...(encounterId ? { encounter: encounterId } : {}) })
}

// ── Identity Select API ─────────────────────────────────────────────────────

/** One identity the signed-in human may act as for this launch. */
export interface Identity {
  reference: string
  resourceType: string
}

/** The identities this launch offered. Not searchable: the session already holds them. */
export async function fetchIdentityOptions(): Promise<Identity[]> {
  const data = await apiFetch<{ identities: Identity[] }>(sessionUrl("/auth/identity-options"))
  return data.identities
}

export function submitIdentitySelection(session: string, code: string, reference: string): Promise<string> {
  return submitSelection("/auth/identity-select", { session, code, identity: reference })
}
