// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { z } from 'zod'
import { basicAuthHeader } from '../http-auth'

export type OAuthTokenGrant =
  | { type: 'client_credentials'; clientId: string; clientSecret?: string; scope?: string }
  | { type: 'token_exchange'; clientId: string; clientSecret?: string; subjectToken: string; subjectTokenType?: string; resource?: string; audience?: string; scope?: string }

export const WwwAuthenticateChallenge = z.object({
  scheme: z.string(),
  params: z.record(z.string(), z.string()).optional(),
})
export type WwwAuthenticateChallengeType = z.infer<typeof WwwAuthenticateChallenge>

const AsMetadata = z.object({
  issuer: z.string().url().optional(),
  authorization_endpoint: z.string().url().optional(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url().optional(),
})

const RsMetadata = z.object({
  resource: z.string().url().optional(),
  authorization_servers: z.array(z.string().url()).optional(),
  token_endpoint: z.string().url().optional(),
}).passthrough()

export interface OAuthBaseOptions {
  discovery?: { protectedResource?: string; authorizationServer?: string }
  tokenGrant?: OAuthTokenGrant
  defaultHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}

export abstract class OAuthMcpBase {
  protected readonly defaultHeaders: Record<string, string>
  protected readonly fetchImpl: typeof fetch
  protected tokenEndpoint?: string
  protected resource?: string
  protected authorizationServer?: string
  protected grant?: OAuthTokenGrant
  protected cachedToken?: { access_token: string; expires_at?: number }

  constructor(opts: OAuthBaseOptions) {
    this.defaultHeaders = opts.defaultHeaders ?? {}
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.grant = opts.tokenGrant
    if (opts.discovery) {
      this.authorizationServer = opts.discovery.authorizationServer
      this.resource = opts.discovery.protectedResource
    }
  }

  protected async ensureDiscovery(): Promise<void> {
    if (this.tokenEndpoint) return
    if (this.authorizationServer) {
      const asRes = await this.fetchImpl(this.authorizationServer, { headers: this.defaultHeaders })
      if (!asRes.ok) throw await this.asError(asRes)
      const as = AsMetadata.parse(await asRes.json())
      this.tokenEndpoint = as.token_endpoint
    }
    if (!this.tokenEndpoint && this.resource) {
      const rsRes = await this.fetchImpl(this.resource, { headers: this.defaultHeaders })
      if (!rsRes.ok) throw await this.asError(rsRes)
      const rs = RsMetadata.parse(await rsRes.json())
      if (rs.token_endpoint) this.tokenEndpoint = rs.token_endpoint
      if (!this.authorizationServer && rs.authorization_servers?.length) this.authorizationServer = rs.authorization_servers[0]
    }
    if (!this.tokenEndpoint && this.authorizationServer) {
      const asRes = await this.fetchImpl(this.authorizationServer, { headers: this.defaultHeaders })
      if (!asRes.ok) throw await this.asError(asRes)
      const as = AsMetadata.parse(await asRes.json())
      this.tokenEndpoint = as.token_endpoint
    }
    if (!this.tokenEndpoint) throw new Error('Unable to discover token endpoint for MCP HTTP client')
  }

  protected async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (this.cachedToken?.access_token && (!this.cachedToken.expires_at || this.cachedToken.expires_at - 30 > now)) {
      return this.cachedToken.access_token
    }
    await this.ensureDiscovery()
    if (!this.tokenEndpoint) throw new Error('Token endpoint not discovered')
    if (!this.grant) throw new Error('No OAuth grant configured for MCP HTTP client')

    const params = new URLSearchParams()
    let clientId: string | undefined
    let clientSecret: string | undefined

    if (this.grant.type === 'client_credentials') {
      params.set('grant_type', 'client_credentials')
      clientId = this.grant.clientId
      clientSecret = this.grant.clientSecret
      if (this.grant.scope) params.set('scope', this.grant.scope)
      if (this.resource) params.set('resource', this.resource)
    } else {
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange')
      clientId = this.grant.clientId
      clientSecret = this.grant.clientSecret
      params.set('subject_token', this.grant.subjectToken)
      params.set('subject_token_type', this.grant.subjectTokenType ?? 'urn:ietf:params:oauth:token-type:access_token')
      if (this.grant.resource ?? this.resource) params.set('resource', this.grant.resource ?? this.resource!)
      if (this.grant.audience) params.set('audience', this.grant.audience)
      if (this.grant.scope) params.set('scope', this.grant.scope)
    }

    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (clientId && clientSecret) {
      headers['authorization'] = basicAuthHeader(clientId, clientSecret)
    } else if (clientId) {
      params.set('client_id', clientId)
    }

    const res = await this.fetchImpl(this.tokenEndpoint!, { method: 'POST', headers, body: params.toString() })
    if (!res.ok) throw await this.asError(res)
    const tok = (await res.json()) as { access_token: string; expires_in?: number }
    const expires_at = tok.expires_in ? Math.floor(Date.now() / 1000) + tok.expires_in : undefined
    this.cachedToken = { access_token: tok.access_token, expires_at }
    return tok.access_token
  }

  protected async asError(res: Response): Promise<Error> {
    const text = await res.text()
    const err = new Error(`HTTP ${res.status}: ${text}`)
    try {
      const www = res.headers.get('www-authenticate')
      if (www) {
        const [scheme, ...paramParts] = www.split(/\s+/)
        const paramsText = paramParts.join(' ')
        const params: Record<string, string> = {}
        paramsText.split(',').forEach((pair) => {
          const [k, v] = pair.split('=')
          if (!k) return
          const vv = v?.trim().replace(/^"|"$/g, '')
          params[k.trim()] = vv ?? ''
        })
        const challenge = WwwAuthenticateChallenge.parse({ scheme, params })
        interface AugmentedError extends Error { wwwAuthenticate?: WwwAuthenticateChallengeType }
        ;(err as AugmentedError).wwwAuthenticate = challenge
      }
    } catch { /* ignore */ }
    return err
  }
}
