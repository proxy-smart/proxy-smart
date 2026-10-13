// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { Child, FC } from 'hono/jsx'
import { config } from '@/config'
import { Document } from './document'
import { htmlResponse, renderDocument } from './render'

export interface StatusAction {
  href: string
  label: string
  secondary?: boolean
}

export interface StatusPageProps {
  title: string
  heading: string
  code?: number
  message?: string
  hint?: string
  actions: readonly StatusAction[]
  footnote?: Child
  children?: Child
}

export const StatusPage: FC<StatusPageProps> = ({ title, heading, code, message, hint, actions, footnote, children }) => (
  <Document title={title} stylesheets={['base', 'status']} bodyClass="status-page">
    <main class="status">
      {code === undefined ? null : <h1 class="status-code">{code}</h1>}
      <h2 class="status-title">{heading}</h2>
      {message || hint ? (
        <p class="status-message">
          {message}
          {hint ? <><br /><span class="status-hint">{hint}</span></> : null}
        </p>
      ) : null}
      {children ? <div class="status-body">{children}</div> : null}
      <div class="status-actions">
        {actions.map(action => (
          <a class={action.secondary ? 'status-action secondary' : 'status-action'} href={action.href}>{action.label}</a>
        ))}
      </div>
      {footnote ? <div class="status-footnote">{footnote}</div> : null}
    </main>
  </Document>
)

const HOME: StatusAction = { href: '/', label: 'Home', secondary: true }

export interface AuthErrorOptions {
  status: number
  error: string
  errorDescription: string
  signedInAs?: string
  logoutUrl?: string
}

/** Only where no client redirect can be trusted; refusals with one go back to the client instead. */
export function authErrorPage(opts: AuthErrorOptions): Response {
  const { status, error, errorDescription, signedInAs, logoutUrl } = opts
  const title = error === 'invalid_request' ? 'Session Expired' : 'Authorization Error'

  const actions: StatusAction[] = []
  if (logoutUrl) actions.push({ href: logoutUrl, label: 'Sign out and use a different account' })
  actions.push({ href: 'javascript:history.back()', label: 'Go Back', secondary: Boolean(logoutUrl) })
  actions.push(HOME)

  return htmlResponse(
    <StatusPage
      title={`${status} · ${title}`}
      code={status}
      heading={title}
      message={errorDescription}
      actions={actions}
      footnote={<>{error}{signedInAs ? <><br />signed in as {signedInAs}</> : null}</>}
    />,
    { status },
  )
}

export function kcUnavailablePage(): Response {
  return htmlResponse(
    <StatusPage
      title="503 · Authentication Unavailable"
      code={503}
      heading="Authentication unavailable"
      message="The identity provider is not responding. This is usually temporary."
      actions={[{ href: 'javascript:location.reload()', label: 'Retry' }, HOME]}
      footnote={<>Persists? Check the <a href="/webapp">admin UI</a></>}
    />,
    { status: 503, headers: { 'Retry-After': '30' } },
  )
}

export function notFoundDocument(path: string): string {
  return renderDocument(
    <StatusPage
      title={`404 · ${config.displayName}`}
      code={404}
      heading="Page not found"
      message={path}
      actions={[{ href: '/', label: 'Back to Home' }]}
    />,
  )
}

export function adminUiAbsentPage(): Response {
  return htmlResponse(
    <StatusPage title="Admin UI not installed" heading="Admin UI not installed" actions={[HOME]}>
      This deployment does not bundle the admin web interface. The same administration surface is available two other ways:
      <ul>
        <li>the REST API under <code>/admin</code>, browsable at <a href="/swagger">/swagger</a></li>
        <li>the MCP endpoint at <code>{config.mcp.path}</code>, where every admin route is exposed as a tool</li>
      </ul>
    </StatusPage>,
    { status: 404 },
  )
}
