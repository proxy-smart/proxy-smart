// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { ENFORCEMENT_DEFAULTS, type EnforcementMode } from '@/lib/enforcement-mode'
import type { IconName } from './icons'

export const PRODUCT = {
  name: 'Proxy Smart',
  tagline: 'Open-source stateless proxy that adds OAuth 2.0 and SMART App Launch 2.2.0 authorization to any FHIR server.',
  author: { name: 'Max Health Inc.', url: 'https://maxhealth.tech' },
  discordUrl: 'https://discord.gg/FshSApM7',
  licenseLabel: 'AGPL-3.0 / Commercial',
  smartSpecUrl: 'http://hl7.org/fhir/smart-app-launch/',
  fhirSpecUrl: 'https://hl7.org/fhir/R4/',
  complianceWorkflow: 'actions/workflows/smart-compliance-tests.yml',
} as const

export interface Listed {
  icon: IconName
  title: string
  detail: string
}

export const YOU_PROVIDE: readonly Listed[] = [
  { icon: 'database', title: 'A FHIR server', detail: 'HAPI FHIR, Microsoft FHIR Server, AWS HealthLake, or any R4 / R4B endpoint' },
  { icon: 'window', title: 'Your SMART apps', detail: 'Patient, provider and backend service launches' },
  { icon: 'key', title: 'Keycloak', detail: 'Included in the Docker setup, so there is nothing extra to install' },
]

export const PROXY_HANDLES: readonly Listed[] = [
  { icon: 'check', title: 'SMART App Launch 2.2.0 flows', detail: 'EHR and standalone launch, PKCE, launch context' },
  { icon: 'check', title: 'OAuth 2.0 authorization and token management', detail: 'JWT validation, refresh token rotation, enterprise SSO via SAML 2.0 and OIDC' },
  { icon: 'check', title: 'Scope-based access control and FHIR proxying', detail: 'Every request checked, then forwarded to the right server' },
]

export interface PipelineStage {
  icon: IconName
  title: string
  description: string
  mode?: { default: EnforcementMode; setting: string }
}

export const PIPELINE: readonly PipelineStage[] = [
  { icon: 'key', title: 'JWT Validation', description: "Verifies the token's signature, expiry and issuer." },
  {
    icon: 'shield',
    title: 'Consent + IAL',
    description: 'Enforces patient consent policies and the required identity assurance level. Off until you enable it.',
    mode: { default: 'disabled', setting: 'CONSENT_ENABLED + CONSENT_MODE' },
  },
  {
    icon: 'lock',
    title: 'SMART Scopes',
    description: "The token's scope must permit the resource type and operation, in SMART v1 or v2 syntax.",
    mode: { default: ENFORCEMENT_DEFAULTS.scopeEnforcement, setting: 'SCOPE_ENFORCEMENT_MODE' },
  },
  {
    icon: 'filter',
    title: 'Role-Based Filtering',
    description: 'Narrows results by fhirUser: patients see their own data, practitioners their assigned patients.',
    mode: { default: ENFORCEMENT_DEFAULTS.roleBasedFiltering, setting: 'ROLE_BASED_FILTERING_MODE' },
  },
]

export const MODE_LABELS: Readonly<Record<EnforcementMode, { short: string; effect: string }>> = {
  'enforce': { short: 'enforce', effect: 'Blocks the request with HTTP 403.' },
  'audit-only': { short: 'audit', effect: 'Logs the violation and lets the request through.' },
  'disabled': { short: 'off', effect: 'Skips the check entirely.' },
}

export const KEYCLOAK_BENCHMARKS = {
  sourceUrl: 'https://www.keycloak.org/high-availability/single-cluster/introduction',
  sizingUrl: 'https://www.keycloak.org/high-availability/multi-cluster/concepts-memory-and-cpu-sizing',
  users: { maxTested: 30_000_000, regularlyTested: 1_000_000 },
  throughput: {
    tokenRefreshes: { label: 'Token refreshes', perSecond: 20_000 },
    clientCredentials: { label: 'Client credential grants', perSecond: 2_000 },
    passwordLogins: { label: 'Password logins', perSecond: 1_000 },
  },
  sizing: [
    { value: '15 logins/s', detail: 'per vCPU, password grant' },
    { value: '120 grants/s', detail: 'per vCPU, client credentials' },
    { value: '120 refreshes/s', detail: 'per vCPU, refresh token' },
    { value: '1,250 MB', detail: 'base memory per Keycloak pod, caching 10,000 sessions' },
  ],
  topology: { zones: 3, podsPerZone: 2, pod: '40 VCPU · 8 GB' },
} as const

export const DEV_SERVICES: readonly { name: string; url: string }[] = [
  { name: 'Backend API', url: 'http://localhost:8445' },
  { name: 'Admin UI', url: 'http://localhost:8445/webapp/' },
  { name: 'Keycloak', url: 'http://localhost:8080' },
  { name: 'Orthanc (DICOMweb)', url: 'http://localhost:8042' },
]

export const PUBLIC_TEST_SERVERS = ['hapi.fhir.org', 'server.fire.ly'] as const
