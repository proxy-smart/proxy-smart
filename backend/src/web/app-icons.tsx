// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { safeUrl } from './render'

const APP_ICON_PATHS = {
  'heart-pulse': '<path d="M19.5 12.572l-7.5 7.428-7.5-7.428A5 5 0 1112 6.006a5 5 0 017.5 6.572z"/><path d="M5 12h2l2-3 3 6 2-3h2"/>',
  'document-text': '<path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
  'shield-check': '<path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>',
  'clipboard-list': '<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>',
  'app-window': '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"/>',
  'stethoscope': '<path d="M4.8 2.3A2 2 0 003 4.5v3A5.5 5.5 0 008.5 13h1a2.5 2.5 0 012.5 2.5v1a3 3 0 006 0v-1.8a5 5 0 00-4-4.9"/><circle cx="19" cy="9" r="2"/><path d="M7.2 2.3A2 2 0 018 4.5"/>',
  'syringe': '<path d="M18 2l4 4m-5.5.5L21 2M10 12l-2 2m6-6l-8 8-4 1 1-4 8-8m4-1l2 2"/>',
  'pill': '<path d="M10.5 1.5l-8 8a4.24 4.24 0 006 6l8-8a4.24 4.24 0 00-6-6m-3 9l6-6"/>',
  'test-tube': '<path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5V2m-2 0h9M9.5 13h5"/>',
  'microscope': '<path d="M6 18h8M3 22h18M14 2v7.5M9.5 16A6.5 6.5 0 0016 9.5V2H9v7.5A6.5 6.5 0 009.5 16z"/>',
  'user': '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'camera': '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
  'dna': '<path d="M2 15c6.667-6 13.333 0 20-6M9 3.236s1 0 3.5 2.764C15 8.764 16 12 16 12m0-8.764s-1 0-3.5 2.764C10 8.764 9 12 9 12m3 10c2.5-2.764 3.5-2.764 3.5-2.764M12 22c-2.5-2.764-3.5-2.764-3.5-2.764M2 9c6.667 6 13.333 0 20 6"/>',
  'phone': '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001.08 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.6.85 1 1.51 1.08H21a2 2 0 010 4h-.09c-.66.08-1.25.47-1.51 1.08z"/>',
  'folder': '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
  'lock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  'lock-open': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>',
  'chart': '<path d="M18 20V10m-6 10V4M6 20v-6"/>',
  'brain': '<path d="M12 2a5 5 0 00-4.78 3.52A4 4 0 004 9.5a4.5 4.5 0 00.96 7.77A4.5 4.5 0 009 22h6a4.5 4.5 0 004.04-4.73A4.5 4.5 0 0020 9.5a4 4 0 00-3.22-3.98A5 5 0 0012 2z"/>',
  'activity': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  'hospital': '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4m-3-8h.01M12 13h.01"/>',
  'scan': '<path d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M7 12h10"/>',
} as const

export type AppIconKey = keyof typeof APP_ICON_PATHS

export const FALLBACK_APP_ICON: AppIconKey = 'app-window'

export function isAppIconKey(value: unknown): value is AppIconKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_ICON_PATHS, value)
}

/** How many tile tones the stylesheets define; a tile picks one by its position. */
export const APP_TONES = 6

/** An app's glyph from the curated set, with its own logo laid over it; a logo that fails to load removes itself. */
export const AppIcon: FC<{ icon: string; logoUri?: string; tone: number; class?: string }> = ({ icon, logoUri, tone, class: extra }) => {
  const glyph = APP_ICON_PATHS[isAppIconKey(icon) ? icon : FALLBACK_APP_ICON]
  const logo = safeUrl(logoUri)
  return (
    <span class={`app-icon tone-${tone % APP_TONES}${extra ? ` ${extra}` : ''}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{raw(glyph)}</svg>
      {logo ? <img src={logo} alt="" loading="lazy" onerror="this.remove()" /> : null}
    </span>
  )
}
