import jwt from 'jsonwebtoken'
import type { LaunchCodePayload, LaunchCodeContext, SmartProxyConfig, SmartProxyLogger } from './types'

/** Stateless HS256 launch codes carrying the EHR context (SMART App Launch 2.2). */
export interface LaunchCodeServiceOptions {
  secret: string
  /** Default 300. */
  ttlSeconds?: number
  issuer: string
  logger?: SmartProxyLogger
}

export type LaunchCodeConfig = Pick<SmartProxyConfig, 'baseUrl' | 'launchCodeSecret' | 'launchCodeTtlSeconds'>

/** The one place signing and verification derive their shared secret, TTL and issuer. */
export function toLaunchCodeOptions(config: LaunchCodeConfig, logger?: SmartProxyLogger): LaunchCodeServiceOptions {
  return {
    secret: config.launchCodeSecret,
    ...(config.launchCodeTtlSeconds !== undefined && { ttlSeconds: config.launchCodeTtlSeconds }),
    issuer: config.baseUrl,
    ...(logger && { logger }),
  }
}

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

/** The embedded context, or null when the code is invalid or expired. */
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
