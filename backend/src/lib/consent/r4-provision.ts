// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ConsentProvision } from 'fhir/r4'

/** A typed root rule moved one level down, under an untyped root that keeps its conditions; null when already R4. */
export function r4Provision(provision: ConsentProvision): ConsentProvision | null {
  if (provision.type === undefined) return null
  const { type, provision: exceptions, ...conditions } = provision
  return { ...conditions, provision: [{ type, ...(exceptions?.length ? { provision: exceptions } : {}) }] }
}
