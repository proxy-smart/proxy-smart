// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export const DEPLOYMENT_STAGES = ['production', 'beta'] as const

export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number]

export const DEFAULT_DEPLOYMENT_STAGE: DeploymentStage = 'production'

export const DEPLOYMENT_STAGE_META = 'deployment-stage'

export const TEST_ENVIRONMENT_NOTICE = {
  headline: 'Test server',
  body: 'This is a test environment. Do not enter or share real patient data or other sensitive information.',
} as const

export function parseDeploymentStage(raw: string | undefined): DeploymentStage {
  const value = raw?.trim().toLowerCase()
  return DEPLOYMENT_STAGES.find(stage => stage === value) ?? DEFAULT_DEPLOYMENT_STAGE
}

export function isTestStage(stage: DeploymentStage | undefined): stage is Exclude<DeploymentStage, 'production'> {
  return stage !== undefined && stage !== 'production'
}
