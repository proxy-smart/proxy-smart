/**
 * @proxy-smart/auth — IdP Adapter Interface
 *
 * Abstraction layer between the SMART proxy and the identity provider.
 * Consumers implement this for their IdP (Keycloak, Auth0, Okta, etc.).
 */

import type { LaunchCodePayload } from '../types'

/** IdP adapter — provides URL construction and endpoint discovery for the identity provider */
export interface IdPAdapter {
  /** Get the IdP's authorization endpoint URL */
  getAuthorizationUrl(): string

  /** Get the IdP's token endpoint URL */
  getTokenUrl(): string

  /**
   * Get the IdP's RFC 8628 device-authorization endpoint URL.
   * Optional: not every IdP exposes the device grant.
   */
  getDeviceAuthorizationUrl?(): string

  /** Get the IdP's introspection endpoint URL */
  getIntrospectionUrl(): string

  /** Get the IdP's RFC 7009 revocation endpoint URL. Optional: not every IdP exposes one. */
  getRevocationUrl?(): string

  /** Get the IdP's logout endpoint URL */
  getLogoutUrl(): string

  /**
   * Map launch context to IdP-specific query parameters.
   * These are added to the authorization URL so the IdP can include
   * them in token claims via protocol mappers.
   *
   * @returns Key-value map of additional query params, or undefined if none.
   */
  getLaunchContextParams?(context: LaunchCodePayload): Record<string, string> | undefined

  /**
   * Get admin client credentials for introspection authentication.
   * Returns null if introspection auth should be handled by the caller.
   */
  getIntrospectionAuth?(): { clientId: string; clientSecret: string } | null

  /**
   * Check if the IdP is reachable (health check).
   * @param fetchFn - The fetch implementation to use
   */
  isReachable?(fetchFn: typeof globalThis.fetch): Promise<boolean>
}
