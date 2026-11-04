import { createHash, randomBytes } from 'node:crypto'
import { isRecord, optionalNumber, optionalString } from './json'

export interface OidcMetadata {
  issuer?: string
  authorization_endpoint?: string
  token_endpoint: string
  device_authorization_endpoint?: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

export interface AuthEndpoints {
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
  userinfoEndpoint?: string
}

/** RFC 8628 §3.2 */
export interface DeviceAuthResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

export interface TokenSet {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  refresh_expires_in?: number
  scope?: string
  id_token?: string
}

/** RFC 6749 §5.2 / RFC 8628 §3.5 */
export interface TokenError {
  error: string
  error_description?: string
}

export function parseOidcMetadata(value: unknown): OidcMetadata {
  if (!isRecord(value) || typeof value.token_endpoint !== 'string') {
    throw new Error('Invalid OIDC metadata: missing token_endpoint')
  }
  return {
    issuer: optionalString(value.issuer),
    authorization_endpoint: optionalString(value.authorization_endpoint),
    token_endpoint: value.token_endpoint,
    device_authorization_endpoint: optionalString(value.device_authorization_endpoint),
    userinfo_endpoint: optionalString(value.userinfo_endpoint),
    end_session_endpoint: optionalString(value.end_session_endpoint),
  }
}

export function parseDeviceAuthResponse(value: unknown): DeviceAuthResponse {
  if (
    !isRecord(value) ||
    typeof value.device_code !== 'string' ||
    typeof value.user_code !== 'string' ||
    typeof value.verification_uri !== 'string' ||
    typeof value.expires_in !== 'number'
  ) {
    throw new Error('Invalid device authorization response from server')
  }
  return {
    device_code: value.device_code,
    user_code: value.user_code,
    verification_uri: value.verification_uri,
    verification_uri_complete: optionalString(value.verification_uri_complete),
    expires_in: value.expires_in,
    interval: optionalNumber(value.interval),
  }
}

export function parseTokenSet(value: unknown): TokenSet {
  if (!isRecord(value) || typeof value.access_token !== 'string') {
    throw new Error('Token response did not include an access_token')
  }
  return {
    access_token: value.access_token,
    token_type: optionalString(value.token_type),
    expires_in: optionalNumber(value.expires_in),
    refresh_token: optionalString(value.refresh_token),
    refresh_expires_in: optionalNumber(value.refresh_expires_in),
    scope: optionalString(value.scope),
    id_token: optionalString(value.id_token),
  }
}

export function asTokenError(value: unknown): TokenError | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') return undefined
  return { error: value.error, error_description: optionalString(value.error_description) }
}

/** The proxy's discovery document names the proxy's own endpoints, so every grant passes its auth layer. */
export function proxyDiscoveryUrl(proxyUrl: string): string {
  return `${proxyUrl.replace(/\/+$/, '')}/auth/.well-known/openid-configuration`
}

export function endpointsFromMetadata(meta: OidcMetadata): AuthEndpoints {
  return {
    tokenEndpoint: meta.token_endpoint,
    deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
    userinfoEndpoint: meta.userinfo_endpoint,
  }
}

/** application/x-www-form-urlencoded, dropping undefined and empty values. */
export function formEncode(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  return search.toString()
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export const PKCE_METHOD_S256 = 'S256' as const

/** RFC 4648 §5, unpadded. */
function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** RFC 7636 §4.2: base64url(SHA-256(ASCII(verifier))). */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest())
}

/** 32 random bytes give a 43-char verifier, the RFC 7636 minimum. */
export function generatePkcePair(randomImpl: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64UrlEncode(randomImpl(32))
  return { verifier, challenge: deriveCodeChallenge(verifier) }
}

/** RFC 8628 §3.1, with the PKCE challenge Keycloak demands of S256 public clients. */
export function deviceAuthBody(
  clientId: string,
  scope: string,
  clientSecret?: string,
  codeChallenge?: string,
): string {
  return formEncode({
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallenge ? PKCE_METHOD_S256 : undefined,
  })
}

/** RFC 8628 §3.4 */
export function deviceTokenBody(
  clientId: string,
  deviceCode: string,
  clientSecret?: string,
  codeVerifier?: string,
): string {
  return formEncode({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    client_secret: clientSecret,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  })
}

export function clientCredentialsBody(clientId: string, clientSecret: string, scope?: string): string {
  return formEncode({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  })
}

export function refreshTokenBody(clientId: string, refreshToken: string, clientSecret?: string): string {
  return formEncode({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  })
}

/** Epoch seconds. */
export function expiresAt(
  expiresIn: number | undefined,
  now: number = Math.floor(Date.now() / 1000),
): number | undefined {
  return typeof expiresIn === 'number' ? now + expiresIn : undefined
}

/** A token with no known expiry counts as fresh; the skew keeps one from expiring mid-request. */
export function isTokenFresh(
  expiresAtSeconds: number | undefined,
  skewSeconds = 30,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (expiresAtSeconds === undefined) return true
  return expiresAtSeconds - skewSeconds > now
}
