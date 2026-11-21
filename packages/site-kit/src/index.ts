// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export { safeUrl, asset } from './url'
export { THEME_STORAGE_KEY, THEME_BOOT_SCRIPT } from './theme'
export { PRODUCT } from './product'
export { AppIcon, Glyph, FALLBACK_APP_ICON, isAppIconKey, type AppIconKey, type GlyphName } from './app-icons'
export { SiteNav, SiteFooter, TestEnvironmentBanner, type NavLink, type SiteSource } from './site-chrome'
export { BASE_CSS } from './base-css'
export { SiteDocument, renderDocument, renderToString, type SiteDocumentProps } from './document'
export {
  DEPLOYMENT_STAGES,
  DEFAULT_DEPLOYMENT_STAGE,
  DEPLOYMENT_STAGE_META,
  TEST_ENVIRONMENT_NOTICE,
  parseDeploymentStage,
  isTestStage,
  type DeploymentStage,
} from './stage'
