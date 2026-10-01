// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { FALLBACK_APP_ICON, type AppIconKey } from '@proxy-smart/site-kit'

const CATEGORY_DEFAULT_ICON: Record<string, AppIconKey> = {
  clinical: 'heart-pulse',
  genomics: 'dna',
  imaging: 'scan',
  patient: 'user',
  admin: 'settings',
  administrative: 'settings',
  consent: 'clipboard-list',
}

export function isLogoUrl(value: string | undefined | null): boolean {
  return !!value && /^https?:\/\//i.test(value)
}

function categoryIcon(category: string | undefined | null): AppIconKey {
  return CATEGORY_DEFAULT_ICON[category ?? ''] ?? FALLBACK_APP_ICON
}

export interface ResolvedAppIcon {
  icon: string
  logoUri?: string
}

export function resolveAppIcon(stored: string | undefined | null, category: string | undefined | null): ResolvedAppIcon {
  if (stored && isLogoUrl(stored)) return { icon: categoryIcon(category), logoUri: stored }
  return { icon: stored && stored.length > 0 ? stored : categoryIcon(category) }
}
