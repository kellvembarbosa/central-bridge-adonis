import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC request signature of the Bridge contract (§2). Framework-free.
 *
 * payload   = UPPER(method) \n pathWithQuery \n timestamp \n sha256_hex(rawBody)
 * signature = hex(hmac_sha256(token, payload))
 */

export const DEFAULT_MAX_SKEW_SECONDS = 300

export type SignatureVerdict = 'valid' | 'unauthorized' | 'timestamp_skew' | 'signature_invalid'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function signaturePayload(
  method: string,
  pathWithQuery: string,
  timestamp: string | number,
  rawBody: string
): string {
  return [method.toUpperCase(), pathWithQuery, String(timestamp), sha256Hex(rawBody ?? '')].join(
    '\n'
  )
}

export function sign(
  token: string,
  method: string,
  pathWithQuery: string,
  timestamp: string | number,
  rawBody: string
): string {
  return createHmac('sha256', token)
    .update(signaturePayload(method, pathWithQuery, timestamp, rawBody), 'utf8')
    .digest('hex')
}

/**
 * Constant-time comparison of two hex strings (received one is lowercased).
 */
export function safeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected.toLowerCase(), 'utf8')
  const b = Buffer.from(received.toLowerCase(), 'utf8')
  if (a.length !== b.length) {
    // Still burn a comparison so timing does not leak length mismatches cheaply.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export interface VerifySignatureInput {
  token: string | null | undefined
  method: string
  pathWithQuery: string
  rawBody: string | null | undefined
  timestamp: string | null | undefined
  signature: string | null | undefined
  /** Current unix time in seconds. Defaults to Date.now(). */
  now?: number
  maxSkewSeconds?: number
}

/**
 * Applies the contract checks in order: missing token / signature / bad
 * timestamp (unauthorized) → clock (timestamp_skew) → HMAC (signature_invalid).
 */
export function verifySignature(input: VerifySignatureInput): SignatureVerdict {
  const token = input.token ?? ''
  const signature = (input.signature ?? '').trim()
  const timestamp = (input.timestamp ?? '').trim()

  if (!token || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return 'unauthorized'
  }

  const now = input.now ?? Math.floor(Date.now() / 1000)
  const maxSkew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS
  if (Math.abs(now - Number(timestamp)) > maxSkew) {
    return 'timestamp_skew'
  }

  const expected = sign(token, input.method, input.pathWithQuery, timestamp, input.rawBody ?? '')
  return safeEqualHex(expected, signature) ? 'valid' : 'signature_invalid'
}
