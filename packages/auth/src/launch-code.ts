/**
 * @proxy-smart/auth — Launch Code Service
 *
 * Issues and verifies stateless signed JWT launch codes per SMART App Launch 2.2.0.
 * The launch code encodes the EHR context (patient, encounter, intent, etc.) as a
 * self-contained, tamper-proof, time-limited token.
 *
 * Flow:
 *   1. EHR/MCP agent → POST /auth/launch → receives {launch: "<JWT>"}
 *   2. App → GET /auth/authorize?launch=<JWT>&scope=launch...
 *   3. Proxy verifies JWT → resolves context → stores in session → redirects to IdP
 */

import jwt from 'jsonwebtoken'
import type { LaunchCodePayload, LaunchCodeContext, SmartProxyConfig, SmartProxyLogger } from './types'

export interface LaunchCodeServiceOptions {
  /** HMAC secret for signing/verifying launch codes */
  secret: string
  /** TTL in seconds (default: 300 = 5 minutes) */
  ttlSeconds?: number
  /** Issuer claim (typically the proxy's baseUrl) */
  issuer: string
  /** Optional logger */
  logger?: SmartProxyLogger
}

/** Config fields a launch code needs. Kept structural so callers can pass a getter-backed object. */
export type LaunchCodeConfig = Pick<SmartProxyConfig, 'baseUrl' | 'launchCodeSecret' | 'launchCodeTtlSeconds'>

/**
 * Derive launch code options from a {@link SmartProxyConfig}.
 *
 * Signing and verification must agree on secret, TTL and issuer, so both sides
 * read them through here rather than assembling the object at each call site.
 */
export function toLaunchCodeOptions(config: LaunchCodeConfig, logger?: SmartProxyLogger): LaunchCodeServiceOptions {
  return {
    secret: config.launchCodeSecret,
    ...(config.launchCodeTtlSeconds !== undefined && { ttlSeconds: config.launchCodeTtlSeconds }),
    issuer: config.baseUrl,
    ...(logger && { logger }),
  }
}

/**
 * Sign a new launch code JWT.
 *
 * @returns Signed JWT string (the launch code)
 */
export function signLaunchCode(payload: LaunchCodePayload, options: LaunchCodeServiceOptions): string {
  const ttl = options.ttlSeconds ?? 300

  const token = jwt.sign(
    { ...payload, type: 'smart_launch' },
    options.secret,
    {
      algorithm: 'HS256',
      expiresIn: ttl,
      issuer: options.issuer,
      jwtid: crypto.randomUUID(),
    }
  )

  options.logger?.debug('Launch code issued', {
    patient: payload.patient,
    encounter: payload.encounter,
    intent: payload.intent,
    clientId: payload.clientId,
    ttl,
  })

  return token
}

type TextClaim = 'patient' | 'encounter' | 'fhirUser' | 'intent' | 'smartStyleUrl' | 'tenant' | 'fhirContext' | 'clientId' | 'sub' | 'fhirBase'

const TEXT_CLAIMS: readonly TextClaim[] = ['patient', 'encounter', 'fhirUser', 'intent', 'smartStyleUrl', 'tenant', 'fhirContext', 'clientId', 'sub', 'fhirBase']

function readPayload(claims: jwt.JwtPayload): LaunchCodePayload {
  const payload: LaunchCodePayload = {}
  for (const key of TEXT_CLAIMS) {
    const value: unknown = claims[key]
    if (typeof value === 'string' && value) payload[key] = value
  }
  if (typeof claims.needPatientBanner === 'boolean') payload.needPatientBanner = claims.needPatientBanner
  if (typeof claims.appContext === 'string') payload.appContext = claims.appContext
  return payload
}

/**
 * Verify a launch code JWT and return the embedded context.
 *
 * @returns Decoded launch context or null if invalid/expired
 */
export function verifyLaunchCode(code: string, options: LaunchCodeServiceOptions): LaunchCodeContext | null {
  try {
    const decoded = jwt.verify(code, options.secret, {
      algorithms: ['HS256'],
      issuer: options.issuer,
    })
    if (typeof decoded === 'string') return null

    if (decoded.type !== 'smart_launch') {
      options.logger?.warn('Launch code verification failed: invalid type claim', { type: decoded.type })
      return null
    }

    const remainingTtl = decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 0
    const payload = readPayload(decoded)

    options.logger?.debug('Launch code verified', {
      patient: payload.patient,
      encounter: payload.encounter,
      remainingTtl,
    })

    return {
      payload,
      remainingTtl,
      ...(decoded.jti && { jti: decoded.jti }),
      ...(decoded.exp && { expiresAt: decoded.exp * 1000 }),
    }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      options.logger?.warn('Launch code expired')
    } else if (error instanceof jwt.JsonWebTokenError) {
      options.logger?.warn('Launch code verification failed', { message: error.message })
    } else {
      options.logger?.error('Launch code verification unexpected error', { error: error instanceof Error ? error.message : String(error) })
    }
    return null
  }
}
