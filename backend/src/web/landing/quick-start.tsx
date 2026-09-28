// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { DEV_SERVICES, PUBLIC_TEST_SERVERS } from './content'
import type { LandingData } from './index'

type Line = { cmd: string; arg?: string } | { comment: string } | { blank: true }

function repoDirName(repositoryUrl: string): string {
  return repositoryUrl.split('/').filter(Boolean).pop() ?? 'proxy-smart'
}

const Shell: FC<{ lines: readonly Line[] }> = ({ lines }) => (
  <pre>
    {lines.map(line => {
      if ('blank' in line) return '\n'
      if ('comment' in line) return <><span class="c"># {line.comment}</span>{'\n'}</>
      return <><span class="k">$</span> {line.cmd}{line.arg ? <> <span class="s">{line.arg}</span></> : null}{'\n'}</>
    })}
  </pre>
)

export const QuickStart: FC<{ data: LandingData }> = ({ data }) => {
  const setup: Line[] = [
    { cmd: 'git clone', arg: `${data.source.repositoryUrl}.git` },
    { cmd: `cd ${repoDirName(data.source.repositoryUrl)}` },
    { cmd: 'bun install' },
    { cmd: 'bun run docker:dev' },
  ]
  const alternatives: Line[] = [
    { blank: true },
    { comment: 'or run the backend locally against that stack' },
    { cmd: 'bun run dev' },
    { blank: true },
    { comment: 'production, separate containers' },
    { cmd: 'bun run docker:prod' },
  ]
  return (
    <section id="quickstart">
      <div class="section-label">Quick Start</div>
      <h2 class="section-title">
        From clone to a running stack <span class="dim">in {setup.length} commands.</span>
      </h2>
      <p class="section-lead">
        The dev stack brings up Keycloak, PostgreSQL, Orthanc and the backend. Requires Bun 1.0 or later and Docker.
      </p>
      <div class="qs-grid">
        <div class="code-block"><Shell lines={[...setup, ...alternatives]} /></div>
        <div>
          <div class="table-card">
            <table>
              <thead><tr><th>Service</th><th>URL</th></tr></thead>
              <tbody>
                {DEV_SERVICES.map(s => <tr><td class="td-label">{s.name}</td><td class="td-value">{s.url}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p class="qs-note">
            Until you register your own FHIR server in the admin UI, the dev stack talks to the public test servers{' '}
            {PUBLIC_TEST_SERVERS.map((host, i) => <>{i > 0 ? ' and ' : null}<code>{host}</code></>)}.
          </p>
          <div class="hero-actions start">
            <a href="/docs" class="btn">Read the docs &rarr;</a>
            <a href={data.source.repositoryUrl} class="btn">GitHub</a>
          </div>
        </div>
      </div>
    </section>
  )
}
