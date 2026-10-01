// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { SiteSource } from '@proxy-smart/site-kit'
import { buildSourceOffer } from '@/lib/source-offer'

export function siteSource(): SiteSource {
  const { version, repositoryUrl, sourceUrl } = buildSourceOffer()
  return { version, repositoryUrl, sourceUrl }
}
