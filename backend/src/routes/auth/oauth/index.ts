// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The proxy's OAuth surface, grouped by what a request is trying to do:
 * start a launch, pick a context, sign in or out, get a token, ask about one, revoke one.
 */

import { Elysia } from 'elysia'
import { launchRoutes } from './launch'
import { contextSelectionRoutes } from './context-selection'
import { loginRoutes } from './login'
import { tokenRoutes } from './token'
import { introspectionRoutes } from './introspection'
import { revocationRoutes } from './revocation'

export const oauthRoutes = new Elysia({ tags: ['authentication'] })
  .use(launchRoutes)
  .use(contextSelectionRoutes)
  .use(loginRoutes)
  .use(tokenRoutes)
  .use(introspectionRoutes)
  .use(revocationRoutes)

export { validateAudience, isKeycloakReachable } from './shared'
