// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { DiscoveredApp } from '../../src/lib/app-discovery'

export function discoveredApp(overrides: Partial<DiscoveredApp> = {}): DiscoveredApp {
  return {
    id: 'probe', launch_url: '/apps/probe/', client_id: 'probe', client_name: 'Probe', description: '', scope: '',
    category: 'clinical', icon: 'user', grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
    hidden: false, source: 'filesystem', ...overrides,
  }
}
