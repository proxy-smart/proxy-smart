// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { ENFORCEMENT_MODES } from '@/lib/enforcement-mode'
import { MODE_LABELS, PIPELINE, type PipelineStage } from './content'
import { Icon } from './icons'

const ModeSwitch: FC<{ mode: NonNullable<PipelineStage['mode']> }> = ({ mode }) => (
  <>
    <div class="modebar" role="img" aria-label={`Configurable: ${ENFORCEMENT_MODES.join(', ')}. Default: ${mode.default}`}>
      {ENFORCEMENT_MODES.map(m => <span class={m === mode.default ? 'on' : undefined}>{MODE_LABELS[m].short}</span>)}
    </div>
    <span class="pipe-var">{mode.setting}</span>
  </>
)

export const Pipeline: FC = () => (
  <section id="security">
    <div class="section-label">Access Control Pipeline</div>
    <h2 class="section-title">
      {PIPELINE.length} checks on every request, <span class="dim">before it reaches your data.</span>
    </h2>
    <p class="section-lead">
      Every FHIR proxy request runs through a layered security pipeline. Each layer can be tuned on its own, so you can roll out
      a stricter policy in audit mode first and switch it to enforce once the logs look clean.
    </p>
    <ol class="pipe">
      <li class="pipe-end"><span>Request</span></li>
      {PIPELINE.map((stage, i) => (
        <li class="pipe-stage">
          <div class="pipe-head">
            <Icon name={stage.icon} />
            <span class="pipe-n">{String(i + 1).padStart(2, '0')}</span>
          </div>
          <div class="pipe-title">{stage.title}</div>
          <p class="pipe-desc">{stage.description}</p>
          {stage.mode ? <ModeSwitch mode={stage.mode} /> : <span class="pill always">Always on</span>}
        </li>
      ))}
      <li class="pipe-end last"><span>FHIR Server</span></li>
    </ol>
    <div class="modes">
      {ENFORCEMENT_MODES.map(m => <div class="mode"><code>{m}</code>{MODE_LABELS[m].effect}</div>)}
    </div>
    <p class="mono-note spaced">
      Consent, scope enforcement and role-based filtering each run in one of these modes. The highlighted mode is the default;
      change it through the environment or at runtime from the admin API.{' '}
      <a href="/docs/environment-variables">Configuration reference</a>
    </p>
  </section>
)
