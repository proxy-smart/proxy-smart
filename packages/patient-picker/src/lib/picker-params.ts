/** Parsed URL parameters for the patient picker. */
export interface PickerParams {
  session: string
  code: string
  /** FHIR server base URL from the aud parameter (per SMART App Launch spec §2.1.9). */
  aud: string
}

/** Error state conveyed via URL params from the backend. */
export interface PickerError {
  error: string
  errorDescription: string
}

/** Parse and validate session/code/aud URL parameters for the patient picker. */
export function getPickerParams(): PickerParams | null {
  const params = new URLSearchParams(window.location.search)
  const session = params.get("session")
  const code = params.get("code")
  const aud = params.get("aud")
  if (!session || !code || !aud) return null
  return { session, code, aud }
}

/** Parse error params passed by the backend redirect on session failure. */
export function getPickerError(): PickerError | null {
  const params = new URLSearchParams(window.location.search)
  const error = params.get("error")
  const errorDescription = params.get("error_description")
  if (!error) return null
  return { error, errorDescription: errorDescription || "An unexpected error occurred." }
}

/** What this step of the launch is choosing. One bundle, one mode per `choose` value. */
export type PickerMode = "patient" | "identity" | "encounter"

export function getPickerMode(): PickerMode {
  const choose = new URLSearchParams(window.location.search).get("choose")
  return choose === "identity" || choose === "encounter" ? choose : "patient"
}
