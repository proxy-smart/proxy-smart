// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/

// "." and ".." are valid FHIR ids but walk a URL path.
export function isFhirId(id: string | undefined): id is string {
  return id !== undefined && FHIR_ID_PATTERN.test(id) && !/^\.+$/.test(id)
}

export interface ReferenceTarget {
  type: string
  id: string
  /** Relative, or absolute under the server's own base. */
  local: boolean
}

const TYPE_ID = '([A-Z][A-Za-z]+)\\/([^/]+)(?:\\/_history\\/[^/]+)?$'
const RELATIVE_REFERENCE_RE = new RegExp(`^${TYPE_ID}`)
const ABSOLUTE_REFERENCE_RE = new RegExp(`\\/${TYPE_ID}`)

/** The `Type/id` a literal reference names; null for urn:, contained (#) and conditional (?) references. */
export function literalReferenceTarget(reference: string, serverUrl: string): ReferenceTarget | null {
  if (/[?#]/.test(reference)) return null
  const base = `${serverUrl.replace(/\/+$/, '')}/`
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(reference)
  const local = !absolute || reference.startsWith(base)
  const match = absolute && !local
    ? ABSOLUTE_REFERENCE_RE.exec(reference)
    : RELATIVE_REFERENCE_RE.exec(local && absolute ? reference.slice(base.length) : reference)
  if (!match || !isFhirId(match[2])) return null
  return { type: match[1], id: match[2], local }
}
