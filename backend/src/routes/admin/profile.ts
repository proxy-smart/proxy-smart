// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Signed-in admin's own profile.
 *
 * The subject is always the `sub` of the caller's token, never a parameter, so
 * these cannot be pointed at another account. Admins can already set any
 * password through /admin/healthcare-users/:userId — this adds no capability,
 * only a place to manage your own without going through user management.
 */

import { Elysia } from 'elysia'
import { keycloakPlugin } from '@/lib/keycloak-plugin'
import { extractBearerToken, getValidatedAdmin } from '@/lib/admin-utils'
import { handleAdminError } from '@/lib/admin-error-handler'
import { validateAdminToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getAttr } from '@/lib/keycloak-component-config'
import {
  ProfileResponse,
  UpdateProfileRequest,
  ChangePasswordRequest,
  ProfileErrorResponse,
} from '@/schemas'

export const profileAdminRoutes = new Elysia({ prefix: '/profile', tags: ['admin'] })
  .use(keycloakPlugin)

  .get('/', async ({ set, headers, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const payload = await validateAdminToken(token)
      const sub = payload.sub
      if (!sub) {
        set.status = 401
        return { error: 'Token has no subject' }
      }

      const admin = await getValidatedAdmin(getAdmin, token)
      const user = await admin.users.findOne({ id: sub })
      if (!user) {
        set.status = 404
        return { error: 'Profile not found' }
      }

      const federated = await admin.users.listFederatedIdentities({ id: sub }).catch(() => [])

      return {
        id: user.id ?? sub,
        username: user.username ?? '',
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified ?? false,
        fhirUser: getAttr(user.attributes, 'fhirUser'),
        organization: getAttr(user.attributes, 'organization'),
        federated: federated.length > 0,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    detail: {
      summary: 'Get my profile',
      description: "The signed-in user's own profile. The subject comes from the access token.",
      tags: ['admin'],
    },
    response: { 200: ProfileResponse, 401: ProfileErrorResponse, 404: ProfileErrorResponse },
  })

  .put('/', async ({ set, headers, body, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const payload = await validateAdminToken(token)
      const sub = payload.sub
      if (!sub) {
        set.status = 401
        return { error: 'Token has no subject' }
      }

      const admin = await getValidatedAdmin(getAdmin, token)
      const existing = await admin.users.findOne({ id: sub })
      if (!existing) {
        set.status = 404
        return { error: 'Profile not found' }
      }

      // Keycloak's PUT replaces the representation, so merge rather than assign.
      const emailChanged = body.email !== undefined && body.email !== existing.email
      await admin.users.update({ id: sub }, {
        firstName: body.firstName ?? existing.firstName,
        lastName: body.lastName ?? existing.lastName,
        email: body.email ?? existing.email,
        // A self-changed address is unverified until proven again.
        emailVerified: emailChanged ? false : existing.emailVerified,
      })

      logger.auth.info('Profile updated by owner', { sub, emailChanged })

      const updated = await admin.users.findOne({ id: sub })
      const federated = await admin.users.listFederatedIdentities({ id: sub }).catch(() => [])

      return {
        id: updated?.id ?? sub,
        username: updated?.username ?? '',
        email: updated?.email,
        firstName: updated?.firstName,
        lastName: updated?.lastName,
        emailVerified: updated?.emailVerified ?? false,
        fhirUser: getAttr(updated?.attributes, 'fhirUser'),
        organization: getAttr(updated?.attributes, 'organization'),
        federated: federated.length > 0,
      }
    } catch (error) {
      return handleAdminError(error, set)
    }
  }, {
    body: UpdateProfileRequest,
    detail: {
      summary: 'Update my profile',
      description: "Updates the signed-in user's own name and email. Changing the email clears its verified flag.",
      tags: ['admin'],
    },
    response: { 200: ProfileResponse, 401: ProfileErrorResponse, 404: ProfileErrorResponse },
  })

  .put('/password', async ({ set, headers, body, getAdmin }) => {
    const token = extractBearerToken(headers)
    if (!token) {
      set.status = 401
      return { error: 'Authorization header required' }
    }

    try {
      const payload = await validateAdminToken(token)
      const sub = payload.sub
      if (!sub) {
        set.status = 401
        return { error: 'Token has no subject' }
      }

      const admin = await getValidatedAdmin(getAdmin, token)
      const existing = await admin.users.findOne({ id: sub })
      if (!existing) {
        set.status = 404
        return { error: 'Profile not found' }
      }

      // A brokered account has no local password to change.
      const federated = await admin.users.listFederatedIdentities({ id: sub }).catch(() => [])
      if (federated.length > 0) {
        set.status = 409
        return { error: 'This account signs in through an identity provider; change the password there' }
      }

      await admin.users.resetPassword({
        id: sub,
        credential: { type: 'password', value: body.newPassword, temporary: false },
      })

      logger.auth.info('Password changed by owner', { sub })
      return { success: true }
    } catch (error) {
      // Realm password-policy rejections arrive here as a Keycloak 400.
      return handleAdminError(error, set)
    }
  }, {
    body: ChangePasswordRequest,
    detail: {
      summary: 'Change my password',
      description:
        'Sets a new password for the signed-in user. Refused for accounts that sign in through an identity provider.',
      tags: ['admin'],
    },
  })
