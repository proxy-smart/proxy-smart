// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The pickers: choosing which identity a launch is for, which patient, and which encounter.
 *
 * Every endpoint here is reached with a launch-session key rather than a token,
 * because none exists yet. A session key is therefore not authorization on its
 * own: the patient endpoints additionally require `pickerAllowed`, which only
 * the callback gate sets, and only for an established practitioner. The encounter
 * endpoints only ever read and accept encounters of the patient already in context.
 */

import { Elysia } from 'elysia'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { resolveClientBrandColors } from '@/lib/org-branding'
import { smartProxyConfig, smartStore, smartLogger } from '../smart-proxy-setup'
import {
  awaitsEncounterChoice,
  continueLaunch,
  handleEncounterSelect,
  handleIdentitySelect,
  handlePatientSelect,
  PRACTITIONER_REQUIRED_MESSAGE,
} from '@proxy-smart/auth'
import {
  findPickerSession,
  pickerErrorBody,
  pickerSubmissionResponse,
  resourceIdsInBundle,
  searchPickerUpstream,
  SESSION_EXPIRED_DESCRIPTION,
} from './picker-support'
import { EncounterSelectBody, IdentitySelectBody, PatientSelectBody, PickerStepQuery } from '@/schemas'

/** Upstream Patient search params the picker may pass through. */
const ALLOWED_SEARCH_PARAMS = ['name', '_count', '_offset', '_sort', '_id', 'family', 'given', 'identifier']

/** Upper bound on the encounters offered, newest first; the offer is also the allowlist. */
export const ENCOUNTER_PICKER_LIMIT = 50

const launchDeps = { config: smartProxyConfig, store: smartStore, logger: smartLogger }

const pickerUrl = (params: Record<string, string>): string => {
  const url = new URL(`${config.baseUrl}/patient-picker/`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.href
}

const fhirJson = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/fhir+json' } })

export const contextSelectionRoutes = new Elysia({ tags: ['authentication'] })

  // ── Identity picker (→ the same React app, in its identity mode) ──
  .get('/identity-options', async ({ query, set }) => {
    const found = findPickerSession(query.session)
    if (!found.ok) {
      set.status = found.status
      return pickerErrorBody(found)
    }

    // Only what the callback already offered: nothing is enumerable here.
    return {
      identities: (found.value.session.identityOffered ?? []).map((reference) => ({
        reference,
        resourceType: reference.split('/')[0] ?? '',
      })),
    }
  }, {
    detail: { summary: 'Identity Options (Picker)', description: 'The identities this launch session offered, for the identity picker SPA.', tags: ['authentication'] }
  })

  .post('/identity-select', async ({ body, headers }) => {
    return pickerSubmissionResponse(handleIdentitySelect(body, launchDeps), headers['content-type'])
  }, {
    body: IdentitySelectBody,
    detail: { summary: 'Identity Selection', description: 'Records which of the signed-in person’s identities this launch is for.', tags: ['authentication'] }
  })

  // ── Patient picker redirect (→ React app at /patient-picker/) ──
  .get('/patient-select', async ({ query, redirect }) => {
    const { session: sessionKey, code } = query

    if (!sessionKey || !code) {
      return redirect(pickerUrl({
        error: 'invalid_request',
        error_description: 'Missing session or code parameter',
      }))
    }

    const session = smartStore.get(sessionKey)
    if (!session) {
      return redirect(pickerUrl({
        error: 'session_expired',
        error_description: SESSION_EXPIRED_DESCRIPTION,
      }))
    }

    // Same gate as the search endpoint: the picker UI is only for users cleared to use it.
    if (!session.pickerAllowed && session.needsPatientPicker) {
      return redirect(pickerUrl({
        error: 'access_denied',
        error_description: PRACTITIONER_REQUIRED_MESSAGE,
      }))
    }

    // Already chosen (e.g. browser back): resume where the launch is, encounter step or client.
    if (!session.needsPatientPicker && session.patient) {
      return pickerSubmissionResponse(continueLaunch(sessionKey, code, launchDeps), undefined)
    }

    return redirect(pickerUrl({
      session: sessionKey,
      code,
      ...(session.aud ? { aud: session.aud } : {}),
    }))
  }, {
    query: PickerStepQuery,
    detail: { summary: 'Patient Picker Redirect', description: 'Redirects to the patient picker React app for standalone SMART launches.', tags: ['authentication'] }
  })

  .post('/patient-select', async ({ body, headers }) => {
    return pickerSubmissionResponse(handlePatientSelect(body, launchDeps), headers['content-type'])
  }, {
    body: PatientSelectBody,
    detail: { summary: 'Patient Picker Submission', description: 'Receives patient selection from the picker UI.', tags: ['authentication'] }
  })

  // ── Patient search (session-validated, for patient picker SPA) ────────
  .get('/patient-search', async ({ query, set }) => {
    const found = findPickerSession(query.session)
    if (!found.ok) {
      set.status = found.status
      return pickerErrorBody(found)
    }
    const { session } = found.value

    // pickerAllowed is set only by the callback gate for a practitioner; a session key alone is not enough.
    if (!session.pickerAllowed) {
      logger.auth.warn('Patient search refused: session was never cleared for the picker', {
        clientId: session.clientId,
      })
      set.status = 403
      return { error: 'access_denied', error_description: PRACTITIONER_REQUIRED_MESSAGE }
    }

    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(query)) {
      if (key !== 'session' && ALLOWED_SEARCH_PARAMS.includes(key) && typeof value === 'string') {
        params[key] = value
      }
    }

    const upstream = await searchPickerUpstream(session.aud, 'Patient', params)
    if (!upstream.ok) {
      set.status = upstream.status
      return pickerErrorBody(upstream)
    }
    return fhirJson(upstream.value.status, upstream.value.body)
  }, {
    detail: { summary: 'Patient Search (Picker)', description: 'Session-validated Patient search for the patient picker SPA. Proxies to upstream FHIR server without requiring a Bearer token.', tags: ['authentication'] }
  })

  // ── Encounter picker: the patient in context's encounters, newest first ──
  .get('/encounter-search', async ({ query, set }) => {
    const found = findPickerSession(query.session)
    if (!found.ok) {
      set.status = found.status
      return pickerErrorBody(found)
    }
    const { key, session } = found.value

    const patient = session.patient
    if (!patient || !awaitsEncounterChoice(session)) {
      set.status = 403
      return { error: 'access_denied', error_description: 'This launch is not choosing an encounter.' }
    }

    const upstream = await searchPickerUpstream(session.aud, 'Encounter', {
      patient: patient.replace(/^Patient\//, ''),
      _sort: '-date',
      _count: String(ENCOUNTER_PICKER_LIMIT),
    })
    if (!upstream.ok) {
      set.status = upstream.status
      return pickerErrorBody(upstream)
    }

    const { status, body } = upstream.value
    if (status >= 200 && status < 300) {
      smartStore.update(key, { encounterOffered: resourceIdsInBundle(body, 'Encounter') })
    }
    return fhirJson(status, body)
  }, {
    detail: { summary: 'Encounter Search (Picker)', description: 'Session-validated search of the selected patient’s encounters for standalone launch/encounter. Only the encounters returned here can be submitted.', tags: ['authentication'] }
  })

  .post('/encounter-select', async ({ body, headers }) => {
    return pickerSubmissionResponse(handleEncounterSelect(body, launchDeps), headers['content-type'])
  }, {
    body: EncounterSelectBody,
    detail: { summary: 'Encounter Picker Submission', description: 'Records the encounter chosen for a standalone launch/encounter, or proceeds without one when the patient has none.', tags: ['authentication'] }
  })

  // ── Brand context (session-validated, for patient picker theming) ─────
  // The launching org's brand COLOUR for theming the picker; not the SMART User-access Brand.
  .get('/brand-context', async ({ query, set }) => {
    const found = findPickerSession(query.session)
    if (!found.ok) {
      set.status = found.status
      return pickerErrorBody(found)
    }

    const brand = await resolveClientBrandColors(found.value.session.clientId)

    set.headers['Cache-Control'] = 'no-store'
    return brand
  }, {
    detail: { summary: 'Brand Context (Picker)', description: 'Session-validated brand colour for theming the patient picker to the launching organization.', tags: ['authentication'] }
  })
