// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Whether a JSON Patch or FHIRPath Patch can reach the elements that decide compartment membership.

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const JsonPatch = Type.Array(Type.Object({
  op: Type.String(),
  path: Type.String(),
  from: Type.Optional(Type.String()),
}, { additionalProperties: true }))

const ParametersPart = Type.Object({
  name: Type.String(),
  valueCode: Type.Optional(Type.String()),
  valueString: Type.Optional(Type.String()),
}, { additionalProperties: true })

const FhirPathPatch = Type.Object({
  resourceType: Type.Literal('Parameters'),
  parameter: Type.Array(Type.Object({
    name: Type.Literal('operation'),
    part: Type.Array(ParametersPart),
  }, { additionalProperties: true })),
}, { additionalProperties: true })

const ELEMENT = '[A-Za-z][A-Za-z0-9]*'
const ELEMENT_RE = new RegExp(`^${ELEMENT}$`)
const SIMPLE_STEP_RE = new RegExp(`^${ELEMENT}(\\[\\d+\\])?$`)

function pointerRoot(pointer: string): string | null {
  if (!pointer.startsWith('/')) return null
  const root = pointer.slice(1).split('/')[0].replaceAll('~1', '/').replaceAll('~0', '~')
  return root || null
}

function partValue(part: ReadonlyArray<{ name: string; valueCode?: string; valueString?: string }>, name: string): string | undefined {
  const found = part.find((p) => p.name === name)
  return found?.valueString ?? found?.valueCode
}

function fhirPathRoot(path: string | undefined, name: string | undefined, resourceType: string): string | null {
  if (!path) return null
  const [head, ...steps] = path.split('.')
  if (head !== resourceType || !steps.every((step) => SIMPLE_STEP_RE.test(step))) return null
  const root = steps.length > 0 ? steps[0].replace(/\[\d+\]$/, '') : name
  return root && ELEMENT_RE.test(root) ? root : null
}

/** Null when no operation can touch a guarded element; otherwise why the patch is refused. */
export function patchRefusal(patch: unknown, resourceType: string, guarded: ReadonlySet<string>): string | null {
  let roots: Array<string | null>
  if (Value.Check(JsonPatch, patch)) {
    roots = patch.flatMap((op) => [pointerRoot(op.path), ...(op.from === undefined ? [] : [pointerRoot(op.from)])])
  } else if (Value.Check(FhirPathPatch, patch)) {
    roots = patch.parameter.map(({ part }) => fhirPathRoot(partValue(part, 'path'), partValue(part, 'name'), resourceType))
  } else {
    return 'Only a JSON Patch or FHIRPath Patch in JSON can be checked against the patient compartment.'
  }
  if (roots.length === 0) return 'The patch has no operations.'
  const named = roots.filter((root): root is string => root !== null)
  if (named.length !== roots.length) {
    return 'Every patch operation must address a single element of the resource by a plain path.'
  }
  const touched = [...new Set(named.filter((root) => guarded.has(root)))]
  return touched.length > 0 ? `The patch changes ${touched.join(', ')}, which decide the patient compartment.` : null
}
