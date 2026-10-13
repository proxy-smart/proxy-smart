/**
 * @proxy-smart/auth — Keycloak IdP Adapter
 *
 * Implements IdPAdapter for Keycloak. Constructs realm-scoped OIDC URLs
 * and maps SMART launch context to Keycloak query parameters accessible
 * via protocol mappers (Script Mapper / client_request_param_*).
 */

import type { LaunchCodePayload } from '../types'
import type { IdPAdapter } from './interface'

export interface KeycloakAdapterConfig {
  /** Keycloak base URL (internal network, for server-to-server calls) */
  baseUrl: string
  /** Keycloak public URL (what browsers see — may differ behind reverse proxy) */
  publicUrl?: string
  /** Realm name (e.g., "proxy-smart") */
  realm: string
  /** Admin service client credentials (for introspection) */
  adminClientId?: string
  adminClientSecret?: string
}

export class KeycloakAdapter implements IdPAdapter {
  private readonly baseUrl: string
  private readonly publicUrl: string
  private readonly realm: string
  private readonly adminClientId?: string
  private readonly adminClientSecret?: string

  constructor(config: KeycloakAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.publicUrl = (config.publicUrl || config.baseUrl).replace(/\/$/, '')
    this.realm = config.realm
    this.adminClientId = config.adminClientId
    this.adminClientSecret = config.adminClientSecret
  }

  getAuthorizationUrl(): string {
    return `${this.publicUrl}/realms/${this.realm}/protocol/openid-connect/auth`
  }

  getTokenUrl(): string {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`
  }

  getDeviceAuthorizationUrl(): string {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/auth/device`
  }

  getIntrospectionUrl(): string {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token/introspect`
  }

  getRevocationUrl(): string {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/revoke`
  }

  getLogoutUrl(): string {
    return `${this.publicUrl}/realms/${this.realm}/protocol/openid-connect/logout`
  }

  getLaunchContextParams(context: LaunchCodePayload): Record<string, string> | undefined {
    const params: Record<string, string> = {}
    let hasParams = false

    if (context.patient) { params.smart_launch_patient = context.patient; hasParams = true }
    if (context.encounter) { params.smart_launch_encounter = context.encounter; hasParams = true }
    if (context.fhirUser) { params.smart_launch_fhir_user = context.fhirUser; hasParams = true }
    if (context.intent) { params.smart_launch_intent = context.intent; hasParams = true }
    if (context.tenant) { params.smart_launch_tenant = context.tenant; hasParams = true }
    if (context.smartStyleUrl) { params.smart_launch_style_url = context.smartStyleUrl; hasParams = true }
    if (context.needPatientBanner !== undefined) { params.smart_launch_need_patient_banner = String(context.needPatientBanner); hasParams = true }
    if (context.fhirContext) { params.smart_launch_fhir_context = context.fhirContext; hasParams = true }

    return hasParams ? params : undefined
  }

  getIntrospectionAuth(): { clientId: string; clientSecret: string } | null {
    if (this.adminClientId && this.adminClientSecret) {
      return { clientId: this.adminClientId, clientSecret: this.adminClientSecret }
    }
    return null
  }

  async isReachable(fetchFn: typeof globalThis.fetch): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/realms/${this.realm}`
      const resp = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
      return resp.ok
    } catch {
      return false
    }
  }
}
