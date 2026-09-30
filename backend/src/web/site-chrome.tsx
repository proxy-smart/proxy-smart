// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { buildSourceOffer } from '@/lib/source-offer'
import { THEME_STORAGE_KEY } from './document'
import { PRODUCT } from './landing/content'

export interface SiteSource {
  version: string
  repositoryUrl: string
  sourceUrl: string
}

export function siteSource(): SiteSource {
  const { version, repositoryUrl, sourceUrl } = buildSourceOffer()
  return { version, repositoryUrl, sourceUrl }
}

export interface NavLink {
  href: string
  label: string
  strong?: boolean
}

const THEME_TOGGLE_SCRIPT = `(function(){var b=document.querySelector('.theme-toggle');if(!b)return;var r=document.documentElement;b.addEventListener('click',function(){var cur=r.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var next=cur==='dark'?'light':'dark';r.dataset.theme=next;try{localStorage.setItem('${THEME_STORAGE_KEY}',next)}catch(e){}})})();`

const NAV_TOGGLE_SCRIPT = `(function(){var t=document.querySelector('.nav-toggle'),l=document.getElementById('navLinks');if(!t||!l)return;function set(o){t.setAttribute('aria-expanded',String(o));l.classList.toggle('open',o)}t.addEventListener('click',function(){set(t.getAttribute('aria-expanded')!=='true')});l.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){set(false)})})})();`

export const SiteNav: FC<{ links: readonly NavLink[] }> = ({ links }) => (
  <nav class="site-nav">
    <div class="nav-inner">
      <a class="nav-brand" href="/"><img src="/proxy-smart.svg" alt="" aria-hidden="true" />{PRODUCT.name}</a>
      <div class="nav-end">
        <ul class="nav-links" id="navLinks">
          {links.map(link => <li><a href={link.href} class={link.strong ? 'nav-strong' : undefined}>{link.label}</a></li>)}
        </ul>
        <button class="theme-toggle" type="button" aria-label="Switch between light and dark theme">
          <svg class="theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
          <svg class="theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
        </button>
        <button class="nav-toggle" aria-expanded="false" aria-controls="navLinks" aria-label="Toggle navigation">
          <span /><span /><span />
        </button>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: NAV_TOGGLE_SCRIPT + THEME_TOGGLE_SCRIPT }} />
  </nav>
)

export const SiteFooter: FC<{ source: SiteSource }> = ({ source }) => (
  <footer>
    <div class="footer-inner">
      <span>
        {PRODUCT.name} <a href={source.sourceUrl}>v{source.version.split('+')[0]}</a>
      </span>
      <div class="footer-links">
        <a href="/docs">Docs</a>
        <a href={source.repositoryUrl}>GitHub</a>
        <a href="/source">Source ({PRODUCT.licenseLabel})</a>
        <a href={PRODUCT.discordUrl}>Discord</a>
        <a href="/llms.txt">llms.txt</a>
      </div>
    </div>
    <div class="footer-legal">
      <span>&copy; {new Date().getFullYear()} <a href={PRODUCT.author.url}>{PRODUCT.author.name}</a> All rights reserved.</span>
    </div>
  </footer>
)
