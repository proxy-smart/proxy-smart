// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

const withErrors = (...types: string[]): string[] => types.flatMap((type) => [type, `${type}_ERROR`])

/** Sign-in, token and consent events, including a sign-in through an external identity provider. */
export const AUTH_EVENT_TYPES: readonly string[] = [
  ...withErrors(
    'LOGIN', 'LOGOUT', 'REGISTER',
    'CODE_TO_TOKEN', 'REFRESH_TOKEN', 'CLIENT_LOGIN', 'TOKEN_EXCHANGE', 'INTROSPECT_TOKEN',
    'GRANT_CONSENT', 'UPDATE_CONSENT', 'REVOKE_GRANT',
    'IDENTITY_PROVIDER_LOGIN', 'IDENTITY_PROVIDER_FIRST_LOGIN', 'IDENTITY_PROVIDER_POST_LOGIN',
    'IDENTITY_PROVIDER_LINK_ACCOUNT', 'FEDERATED_IDENTITY_LINK',
    'UPDATE_PROFILE', 'UPDATE_PASSWORD',
  ),
  'PERMISSION_TOKEN',
]

/** Events that send the user an email or act on a link from one. */
export const EMAIL_EVENT_TYPES: readonly string[] = withErrors(
  'SEND_RESET_PASSWORD', 'SEND_VERIFY_EMAIL', 'SEND_IDENTITY_PROVIDER_LINK',
  'EXECUTE_ACTIONS', 'EXECUTE_ACTION_TOKEN', 'CUSTOM_REQUIRED_ACTION',
)

/** What the realm records: exactly what the auth and email event loggers poll for. */
export const ENABLED_EVENT_TYPES: readonly string[] = [...AUTH_EVENT_TYPES, ...EMAIL_EVENT_TYPES]
