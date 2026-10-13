// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** RFC 7636 Appendix B: the S256 challenge of a known verifier. */
export const PKCE_VERIFIER = 'dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk'
export const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

export const PKCE_PARAMS = { code_challenge: PKCE_CHALLENGE, code_challenge_method: 'S256' }
