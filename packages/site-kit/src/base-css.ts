// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/// <reference path="./text-modules.d.ts" />
import css from '../css/base.css' with { type: 'text' }

/** The shared stylesheet as text, so bundlers inline it and each site serves it at its own path. */
export const BASE_CSS: string = css
