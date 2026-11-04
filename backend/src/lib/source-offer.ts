// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'

/** AGPL section 13 offer, pinned to the deployed commit when the version names one. */
export interface SourceOffer {
  software: string
  version: string
  /** Resolved git commit SHA when derivable from the version string, else null. */
  commit: string | null
  /** SPDX license expression for this software. */
  license: string
  repositoryUrl: string
  /** Link to the corresponding source for the deployed version specifically. */
  sourceUrl: string
  commercial: {
    note: string
    contact: string
  }
}

/** SHA from SemVer build metadata (`0.4.6+10a84383`) or the release trailer (`0.2.13-beta.<build>.<sha>`). */
export function commitFromVersion(version: string): string | null {
  const isSha = (value: string) => /^[0-9a-f]{7,40}$/i.test(value)

  const build = version.split('+')[1]
  if (build && isSha(build)) return build

  // At least three segments: a lone all-digit build number is valid hex but no commit.
  const prerelease = version.split('-').slice(1).join('-')
  const parts = prerelease.split('.')
  const last = parts[parts.length - 1] ?? ''
  return parts.length >= 3 && isSha(last) ? last : null
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function buildSourceOffer(): SourceOffer {
  const version = config.version
  const repositoryUrl = stripTrailingSlash(config.source.repositoryUrl)
  const commit = commitFromVersion(version)

  // '0.0.1-alpha' is config's fallback when package.json cannot be read.
  const sourceUrl = commit
    ? `${repositoryUrl}/tree/${commit}`
    : version && version !== '0.0.1-alpha'
      ? `${repositoryUrl}/releases/tag/v${version}`
      : repositoryUrl

  return {
    software: config.displayName,
    version,
    commit,
    license: config.source.license,
    repositoryUrl,
    sourceUrl,
    commercial: {
      note:
        'This software is dual-licensed. Network use is governed by AGPL-3.0-or-later '
        + 'unless a separate commercial license has been obtained.',
      contact: config.source.commercialContact,
    },
  }
}

/** Plain-text rendering for `Accept: text/plain` clients and curl. */
export function renderSourceOfferText(offer: SourceOffer): string {
  return [
    `${offer.software} ${offer.version}`,
    `License: ${offer.license}`,
    `Corresponding source (AGPL section 13): ${offer.sourceUrl}`,
    `Repository: ${offer.repositoryUrl}`,
    offer.commit ? `Commit: ${offer.commit}` : null,
    '',
    offer.commercial.note,
    `Commercial licensing: ${offer.commercial.contact}`,
    '',
  ].filter(v => v !== null).join('\n')
}
