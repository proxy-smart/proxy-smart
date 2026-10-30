// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord } from '../type-guards'

export type ScreenedAnswer = { status: number; body: unknown }

export interface PatientScreen {
  patientsOf: (resource: unknown) => string[]
  refusedAmong: (patientIds: string[]) => Promise<Set<string> | null>
  enforce: boolean
  refusal: ScreenedAnswer
  unverifiable: ScreenedAnswer
  report: (detail: { removed: number; patients: number } | { resourceType: unknown }) => void
}

export async function screenAnswer(answer: ScreenedAnswer, screen: PatientScreen): Promise<ScreenedAnswer> {
  const { body } = answer
  if (!isRecord(body) || answer.status >= 300) return answer

  if (body.resourceType === 'Bundle') {
    const entries = Array.isArray(body.entry) ? body.entry : []
    const patientsOf = entries.map((entry) => (isRecord(entry) ? screen.patientsOf(entry.resource) : []))
    const refused = await screen.refusedAmong(patientsOf.flat())
    if (!refused) return screen.unverifiable
    if (refused.size === 0) return answer
    const kept = entries.filter((_, i) => !patientsOf[i].some((id) => refused.has(id)))
    screen.report({ removed: entries.length - kept.length, patients: refused.size })
    return screen.enforce ? { status: answer.status, body: { ...body, entry: kept } } : answer
  }

  const patients = screen.patientsOf(body)
  if (patients.length === 0) return answer
  const refused = await screen.refusedAmong(patients)
  if (!refused) return screen.unverifiable
  if (refused.size === 0) return answer
  screen.report({ resourceType: body.resourceType })
  return screen.enforce ? screen.refusal : answer
}
