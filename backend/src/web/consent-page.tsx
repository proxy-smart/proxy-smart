// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isLoopbackUri } from '@proxy-smart/auth'
import { StatusPage } from './status-pages'
import { htmlResponse } from './render'

export interface ConsentPageProps {
  /** The client's name with the host that vouches for it. */
  clientName: string
  clientHost: string
  clientId: string
  resource?: string
  /** Where the code goes if the user allows. */
  redirectUri: string
  scopes: readonly string[]
  sessionKey: string
  code: string
  action: string
}

/** Never framed (clickjacking), never cached (it carries a live code). */
const CONSENT_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

/** MCP 2025-11-25: a loopback redirect deserves a warning, since a client ID document cannot stop local impersonation. */
const LOOPBACK_WARNING = 'Any program on this computer can listen on this address. Only continue if you started this connection yourself just now.'

function destination(redirectUri: string): { host: string; loopback: boolean } {
  return { host: new URL(redirectUri).host, loopback: isLoopbackUri(redirectUri) }
}

export function consentPage(props: ConsentPageProps): Response {
  const { clientName, clientHost, clientId, resource, redirectUri, scopes, sessionKey, code, action } = props
  const target = destination(redirectUri)
  return htmlResponse(
    <StatusPage
      title="Allow access?"
      heading={`Allow ${clientName} to access your data?`}
      message={`Only allow this if you trust ${clientHost}.`}
      actions={[]}
      footnote={<>Client identifier: {clientId}</>}
    >
      <dl class="consent-details">
        <dt>Requested by</dt>
        <dd><strong>{clientHost}</strong></dd>
        {resource ? <><dt>Access to</dt><dd>{resource}</dd></> : null}
        <dt>Sent to</dt>
        <dd>{target.loopback ? <>{target.host}, a program running on this computer</> : target.host}</dd>
        {scopes.length > 0 ? (
          <>
            <dt>Permissions</dt>
            <dd><ul>{scopes.map((scope) => <li><code>{scope}</code></li>)}</ul></dd>
          </>
        ) : null}
      </dl>
      {target.loopback ? <p class="status-hint consent-warning">{LOOPBACK_WARNING}</p> : null}
      <form method="post" action={action} class="status-actions">
        <input type="hidden" name="session" value={sessionKey} />
        <input type="hidden" name="code" value={code} />
        <button type="submit" name="decision" value="approve" class="status-action">Allow</button>
        <button type="submit" name="decision" value="deny" class="status-action secondary">Deny</button>
      </form>
    </StatusPage>,
    { headers: CONSENT_HEADERS },
  )
}
