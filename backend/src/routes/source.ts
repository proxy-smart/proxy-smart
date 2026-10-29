// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Elysia, t, type Context } from 'elysia'
import { buildSourceOffer, renderSourceOfferText, type SourceOffer } from '../lib/source-offer'

const SourceOfferResponse = t.Object({
  software: t.String(),
  version: t.String(),
  commit: t.Union([t.String(), t.Null()]),
  license: t.String(),
  repositoryUrl: t.String(),
  sourceUrl: t.String(),
  commercial: t.Object({
    note: t.String(),
    contact: t.String(),
  }),
}, { description: 'AGPL section 13 corresponding-source offer for the deployed version' })

function wantsText(accept: string): boolean {
  return accept.includes('text/plain') && !accept.includes('application/json')
}

// Standalone handlers need Elysia's exported `Context` type (elysiajs/elysia#95); text bypasses schema coercion.
function handleSourceOffer({ headers, set }: Context<{ response: { 200: SourceOffer } }>): Response | SourceOffer {
  const offer = buildSourceOffer()
  set.headers['cache-control'] = 'public, max-age=300'
  if (wantsText(headers['accept'] ?? '')) {
    return new Response(renderSourceOfferText(offer), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  }
  return offer
}

const detail = {
  summary: 'AGPL Source Offer',
  description:
    'Corresponding source offer required by AGPL-3.0 section 13, pinned to the '
    + 'deployed version/commit. Returns JSON, or plain text for Accept: text/plain.',
  tags: ['server'],
}

export const sourceRoutes = new Elysia({ tags: ['server'] })
  .get('/source', handleSourceOffer, { response: { 200: SourceOfferResponse }, detail })
  .get('/.well-known/agpl-source', handleSourceOffer, {
    response: { 200: SourceOfferResponse },
    detail: { ...detail, summary: 'AGPL Source Offer (well-known)' },
  })
