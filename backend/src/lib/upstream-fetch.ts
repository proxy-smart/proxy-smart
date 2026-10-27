// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** How the proxy reaches an upstream server: plain fetch, mTLS, or a stand-in under test. */
export type UpstreamFetch = (url: string, init?: RequestInit) => Promise<Response>
