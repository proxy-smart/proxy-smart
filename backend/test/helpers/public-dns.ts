// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, beforeAll } from 'bun:test'
import { outboundUrlPolicy } from '@/lib/url-validation'

export function usePublicDns(addresses: string[] = ['93.184.215.14']): void {
  const original = outboundUrlPolicy.resolve
  beforeAll(() => { outboundUrlPolicy.resolve = async () => addresses })
  afterAll(() => { outboundUrlPolicy.resolve = original })
}
