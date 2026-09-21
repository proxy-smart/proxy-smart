// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Launch Context Session Store
 *
 * Per-session state for the SMART on FHIR authorization flow, keyed by the OAuth
 * `state` param and consumed at token exchange:
 *
 *   App -> /authorize -> IdP /auth -> /auth/smart-callback -> [picker?] -> App with code
 *   App -> /token -> proxy reads session context + IdP token -> enriched response
 *
 * The implementation is @proxy-smart/auth's MemoryStore, which is what the library's
 * own authorize/callback/token handlers write through. This module only binds it to
 * the backend logger and exposes the process singleton. Swap in a Redis-backed
 * ILaunchContextStore here for multi-node deployments.
 */

import { MemoryStore } from '@proxy-smart/auth'
import { smartLogger } from './smart-logger'

export type { LaunchSession, ILaunchContextStore, LaunchContextStoreOptions } from '@proxy-smart/auth'

/** Singleton instance — imported by oauth routes and smart-proxy-setup */
export const launchContextStore = new MemoryStore({ logger: smartLogger })
