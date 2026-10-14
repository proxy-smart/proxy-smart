// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** A bearer token that fails validation on an MCP mount; each mount's `onError` maps it to a 401. */
export class McpUnauthorizedError extends Error {}
