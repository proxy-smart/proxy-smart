// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Client Policies Schemas
 *
 * TypeBox schemas for Keycloak client policies/profiles admin management.
 * Used by the CIMD (Client ID Metadata Document) setup flow and general client policy config.
 */

import { t, type Static } from 'elysia'

// ── Executor (inside a profile) ──────────────────────────────────────────────

export const ClientPolicyExecutor = t.Object({
  executor: t.String({ description: 'Executor provider ID (e.g. "client-id-metadata-document")' }),
  configuration: t.Optional(t.Record(t.String(), t.Any(), { description: 'Executor-specific configuration' })),
}, { title: 'ClientPolicyExecutor' })

export type ClientPolicyExecutorType = Static<typeof ClientPolicyExecutor>

// ── Profile ──────────────────────────────────────────────────────────────────

export const ClientProfile = t.Object({
  name: t.String({ description: 'Profile name' }),
  description: t.Optional(t.String({ description: 'Profile description' })),
  executors: t.Optional(t.Array(ClientPolicyExecutor, { description: 'Executors attached to this profile' })),
}, { title: 'ClientProfile' })

export type ClientProfileType = Static<typeof ClientProfile>

export const ClientProfilesResponse = t.Object({
  profiles: t.Optional(t.Array(ClientProfile, { description: 'Realm-defined profiles' })),
  globalProfiles: t.Optional(t.Array(ClientProfile, { description: 'Built-in global profiles (read-only)' })),
}, { title: 'ClientProfilesResponse' })

export type ClientProfilesResponseType = Static<typeof ClientProfilesResponse>

// ── Condition (inside a policy) ──────────────────────────────────────────────

export const ClientPolicyCondition = t.Object({
  condition: t.String({ description: 'Condition provider ID (e.g. "client-id-uri")' }),
  configuration: t.Optional(t.Record(t.String(), t.Any(), { description: 'Condition-specific configuration' })),
}, { title: 'ClientPolicyCondition' })

export type ClientPolicyConditionType = Static<typeof ClientPolicyCondition>

// ── Policy ───────────────────────────────────────────────────────────────────

export const ClientPolicy = t.Object({
  name: t.String({ description: 'Policy name' }),
  description: t.Optional(t.String({ description: 'Policy description' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether the policy is active', default: true })),
  conditions: t.Optional(t.Array(ClientPolicyCondition, { description: 'Conditions that trigger this policy' })),
  profiles: t.Optional(t.Array(t.String(), { description: 'Profile names to apply when conditions match' })),
}, { title: 'ClientPolicy' })

export type ClientPolicyType = Static<typeof ClientPolicy>

export const ClientPoliciesResponse = t.Object({
  policies: t.Optional(t.Array(ClientPolicy, { description: 'Realm-defined policies' })),
  globalPolicies: t.Optional(t.Array(ClientPolicy, { description: 'Built-in global policies (read-only)' })),
}, { title: 'ClientPoliciesResponse' })

export type ClientPoliciesResponseType = Static<typeof ClientPoliciesResponse>

// ── CIMD Setup Convenience ───────────────────────────────────────────────────

export const CimdSetupRequest = t.Object({
  trustedDomains: t.Array(t.String({ description: 'A host ("claude.ai"), ".example.org" for the domain and its subdomains, or "*.example.org" for subdomains only' }), {
    description: 'Domains whose Client ID Metadata Documents may name a client; empty disables CIMD',
  }),
}, { title: 'CimdSetupRequest' })

export type CimdSetupRequestType = Static<typeof CimdSetupRequest>

export const CimdSetupResponse = t.Object({
  success: t.Boolean(),
  message: t.String(),
  trustedDomains: t.Array(t.String()),
}, { title: 'CimdSetupResponse' })

export type CimdSetupResponseType = Static<typeof CimdSetupResponse>

export const CimdStatusResponse = t.Object({
  enabled: t.Boolean({ description: 'Whether any domain may name a client by its metadata document' }),
  trustedDomains: t.Array(t.String()),
}, { title: 'CimdStatusResponse' })

export type CimdStatusResponseType = Static<typeof CimdStatusResponse>
