// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Common schemas (responses, pagination)
export * from './common'

// Admin schemas (users, apps, servers, roles, etc.)
export * from './admin'

// Authentication schemas (OAuth, tokens, client registration)
export * from './auth'

// Documentation schemas (public doc routes)
export * from './docs'

// FHIR schemas (SMART configuration, FHIR responses)
export * from './fhir'

// Self-service profile schemas
export * from './profile'

// OAuth monitoring schemas (events, analytics, health)
export * from './monitoring'

// Websocket schemas (messages, notifications)
export * from './websocket'

// MCP schemas (authorization discovery, MCP HTTP transport)
export * from './mcp'

// Consent schemas (consent enforcement)
export * from './consent'

// Admin audit schemas (audit trail events + analytics)
export * from './admin-audit'

// Email monitoring schemas (Keycloak email event tracking)
export * from './email-monitoring'

// Auth monitoring schemas (Keycloak login/logout/register event tracking)
export * from './auth-monitoring'

// SMART App State schemas (smart-app-state capability)
export * from './app-state'
