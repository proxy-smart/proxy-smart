// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { PRODUCT } from './content'
import type { LandingData } from './index'

const SECTIONS = [
  { href: '#architecture', label: 'Architecture' },
  { href: '#security', label: 'Security' },
  { href: '#appstore', label: 'App Store' },
  { href: '#scale', label: 'Scale' },
  { href: '#quickstart', label: 'Quick Start' },
  { href: '#faq', label: 'FAQ' },
] as const

const NAV_TOGGLE_SCRIPT = `(function(){var t=document.querySelector('.nav-toggle'),l=document.getElementById('navLinks');if(!t||!l)return;function set(o){t.setAttribute('aria-expanded',String(o));l.classList.toggle('open',o)}t.addEventListener('click',function(){set(t.getAttribute('aria-expanded')!=='true')});l.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){set(false)})})})();`

export const Nav: FC<{ data: LandingData }> = ({ data }) => (
  <nav>
    <div class="nav-inner">
      <a class="nav-brand" href="/"><img src="/proxy-smart.svg" alt="" aria-hidden="true" />{PRODUCT.name}</a>
      <button class="nav-toggle" aria-expanded="false" aria-controls="navLinks" aria-label="Toggle navigation">
        <span /><span /><span />
      </button>
      <ul class="nav-links" id="navLinks">
        {SECTIONS.map(s => <li><a href={s.href}>{s.label}</a></li>)}
        <li><a href="/docs" class="nav-strong">Docs</a></li>
        <li><a href={data.source.repositoryUrl}>GitHub</a></li>
      </ul>
    </div>
    <script dangerouslySetInnerHTML={{ __html: NAV_TOGGLE_SCRIPT }} />
  </nav>
)

export const Footer: FC<{ data: LandingData }> = ({ data }) => (
  <footer>
    <div class="footer-inner">
      <span>
        {PRODUCT.name} <a href={data.source.sourceUrl}>v{data.source.version.split('+')[0]}</a>
      </span>
      <div class="footer-links">
        <a href="/docs">Docs</a>
        <a href={data.source.repositoryUrl}>GitHub</a>
        <a href="/source">Source ({PRODUCT.licenseLabel})</a>
        <a href={PRODUCT.discordUrl}>Discord</a>
        <a href="/llms.txt">llms.txt</a>
      </div>
    </div>
    <div class="footer-legal">
      <span>&copy; {new Date().getFullYear()} {PRODUCT.author.name}. All rights reserved.</span>
    </div>
  </footer>
)
