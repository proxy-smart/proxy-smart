// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Email Service — Resend SDK wrapper for transactional emails.
 *
 * Uses RESEND_API_KEY from environment. Falls back gracefully when not configured.
 * The from address defaults to noreply@maxhealth.tech (same as Keycloak SMTP).
 */

import { Resend } from 'resend'
import { logger } from './logger'

const DEFAULT_FROM = 'Proxy Smart <noreply@maxhealth.tech>'

let _resend: Resend | null = null

function getClient(): Resend | null {
  if (_resend) return _resend
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  _resend = new Resend(apiKey)
  return _resend
}

const recipientCount = (to: string | string[]): number => (Array.isArray(to) ? to.length : 1)

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY
}

export interface SendEmailOptions {
  to: string | string[]
  subject: string
  html: string
  /** Plain-text fallback */
  text?: string
  from?: string
  replyTo?: string
}

/**
 * Send a transactional email via Resend.
 * Returns true on success, false if email is not configured or sending failed.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const client = getClient()
  if (!client) {
    logger.server.debug('Email not configured (RESEND_API_KEY missing) — skipping send')
    return false
  }

  try {
    const { data, error } = await client.emails.send({
      from: opts.from ?? DEFAULT_FROM,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo,
    })

    if (error) {
      logger.server.error('Failed to send email', { error, recipients: recipientCount(opts.to), subject: opts.subject })
      return false
    }

    logger.server.info('Email sent', { id: data?.id, recipients: recipientCount(opts.to), subject: opts.subject })
    return true
  } catch (err) {
    logger.server.error('Email send threw', { err, recipients: recipientCount(opts.to), subject: opts.subject })
    return false
  }
}
