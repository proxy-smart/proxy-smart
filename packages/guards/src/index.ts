// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export { isRecord, requireRecord, stringEntries, parseJson, parseJsonRecord } from './record'
export { optionalString, optionalNumber, isStringArray, stringArray, stringList, isOneOf } from './values'
export { isHttpUrl, sameOrigin, trimTrailingSlashes } from './url'
export {
  ENFORCEMENT_MODES,
  ACCESS_POSTURE_SETTINGS,
  isEnforcementMode,
  requireEnforcementMode,
  accessPostureMode,
  parseAccessPosture,
  type EnforcementMode,
  type AccessPostureKey,
  type AccessPosture,
} from './posture'
