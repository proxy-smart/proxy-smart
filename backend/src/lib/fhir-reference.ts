// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/

// "." and ".." are valid FHIR ids but walk a URL path.
export function isFhirId(id: string | undefined): id is string {
  return id !== undefined && FHIR_ID_PATTERN.test(id) && !/^\.+$/.test(id)
}
