// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Notification Routes (SMART-authenticated)
 *
 * POST /api/consent/notify-access-request
 *
 * Sends an email notification to a patient when a practitioner requests
 * access to their data. Looks up the patient's email from Keycloak,
 * then sends via Resend.
 */

import { Elysia, t } from 'elysia'
import { getServiceAccountAdmin } from '@/lib/service-account-admin'
import { logger } from '@/lib/logger'
import { config } from '@/config'
import { validateToken } from '@/lib/auth'
import { normalizeFhirUser } from '@/lib/patient-context'
import { extractBearerToken } from '@/lib/admin-utils'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { getConsentConfig } from '@/lib/consent'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a Keycloak user whose fhirUser attribute matches a Patient/id reference */
async function findUserEmailByFhirPatient(patientRef: string): Promise<string | null> {
  if (!config.keycloak.isConfigured) return null

  try {
    const admin = await getServiceAccountAdmin()
    // Search by attribute: fhirUser = Patient/<id>
    const users = await admin.users.find({
      realm: config.keycloak.realm!,
      q: `fhirUser:${patientRef}`,
      max: 5,
    })

    for (const u of users) {
      if (u.email && u.emailVerified) return u.email
    }

    return null
  } catch (err) {
    logger.server.error('Failed to look up patient email', { err, patientRef })
    return null
  }
}

function buildAccessRequestEmailHtml(params: {
  patientName: string
  practitionerName: string
  reason?: string
  resourceTypes: string[]
  consentAppUrl: string
}): string {
  const { patientName, practitionerName, reason, resourceTypes, consentAppUrl } = params
  const typesList = resourceTypes.length > 0
    ? resourceTypes.map(t => `<li>${escapeHtml(t)}</li>`).join('')
    : '<li>All available records</li>'

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <div style="border-bottom: 2px solid #0066cc; padding-bottom: 16px; margin-bottom: 24px;">
    <h2 style="margin: 0; color: #0066cc;">New Access Request</h2>
  </div>
  
  <p>Hi ${escapeHtml(patientName)},</p>
  
  <p><strong>${escapeHtml(practitionerName)}</strong> has requested access to your medical records.</p>
  
  ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
  
  <p><strong>Requested records:</strong></p>
  <ul>${typesList}</ul>
  
  <p>You can review and approve or deny this request in your consent portal:</p>
  
  <div style="text-align: center; margin: 32px 0;">
    <a href="${escapeHtml(consentAppUrl)}" 
       style="background-color: #0066cc; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
      Review Request
    </a>
  </div>
  
  <p style="color: #666; font-size: 13px;">
    If you did not expect this request, you can safely ignore this email or deny the request.
  </p>
  
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="color: #999; font-size: 12px;">
    This is an automated notification from Proxy Smart. Do not reply to this email.
  </p>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Route ────────────────────────────────────────────────────────────────────

export const consentNotifyRoutes = new Elysia({ prefix: '/consent', tags: ['consent'] })
  .post(
    '/notify-access-request',
    async ({ body, set, headers }) => {
      // Validate SMART access token (practitioner must be authenticated)
      const token = extractBearerToken(headers)
      if (!token) {
        set.status = 401
        return { error: 'Unauthorized', details: 'Bearer token required' }
      }

      let caller: Awaited<ReturnType<typeof validateToken>>
      try {
        caller = await validateToken(token)
      } catch {
        set.status = 401
        return { error: 'Unauthorized', details: 'Invalid or expired token' }
      }

      // Only a practitioner asks a patient for access; any other caller could use this to email any patient.
      const fhirUser = typeof caller.fhirUser === 'string' ? normalizeFhirUser(caller.fhirUser) : ''
      if (!/^(Practitioner|PractitionerRole)\//.test(fhirUser)) {
        set.status = 403
        return { error: 'Forbidden', details: 'Only a practitioner can request access to a patient record' }
      }

      if (!isEmailConfigured()) {
        set.status = 503
        return { error: 'Email not configured', details: 'RESEND_API_KEY is not set' }
      }

      const { patientReference, patientName, practitionerName, reason, resourceTypes } = body

      // Look up patient's email from Keycloak
      const patientEmail = await findUserEmailByFhirPatient(patientReference)
      if (!patientEmail) {
        logger.server.info('No email found for patient — skipping notification', { patientReference })
        return { sent: false, reason: 'Patient email not found or not verified' }
      }

      // Build the consent app URL
      const consentAppUrl = getConsentConfig().appUrl || `${config.baseUrl}/consent-app/`

      const sent = await sendEmail({
        to: patientEmail,
        subject: `${practitionerName} requested access to your medical records`,
        html: buildAccessRequestEmailHtml({
          patientName: patientName || 'there',
          practitionerName,
          reason,
          resourceTypes: resourceTypes || [],
          consentAppUrl,
        }),
        text: `${practitionerName} has requested access to your medical records. Visit ${consentAppUrl} to review and approve or deny this request.`,
      })

      return { sent }
    },
    {
      body: t.Object({
        patientReference: t.String({ description: 'FHIR Patient reference (e.g. Patient/123)' }),
        patientName: t.Optional(t.String({ description: 'Patient display name' })),
        practitionerName: t.String({ description: 'Practitioner display name' }),
        reason: t.Optional(t.String({ description: 'Reason for access request' })),
        resourceTypes: t.Optional(t.Array(t.String(), { description: 'Requested FHIR resource types' })),
      }),
      detail: {
        summary: 'Notify patient of access request',
        description: 'Sends an email to the patient when a practitioner requests access to their data.',
      },
    },
  )
