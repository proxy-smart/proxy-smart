// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ExternalUrlPolicy } from '@proxy-smart/auth'

export const outboundUrlPolicy: ExternalUrlPolicy = { allowInternal: process.env.NODE_ENV === 'development' }
