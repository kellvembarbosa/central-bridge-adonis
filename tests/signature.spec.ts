import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { sign, signaturePayload, verifySignature, sha256Hex } from '../src/core/signature.ts'

// Standalone repo: ./test-vectors. Monorepo: ../bridge-test-vectors (canonical).
function vectorsFile(file: string) {
  const local = new URL(`../test-vectors/${file}`, import.meta.url)
  return existsSync(local) ? local : new URL(`../../bridge-test-vectors/${file}`, import.meta.url)
}

const vectors = JSON.parse(
  readFileSync(vectorsFile('signature.json'), 'utf8')
) as {
  token: string
  max_skew_seconds: number
  cases: Array<{
    name: string
    method: string
    path: string
    timestamp: number
    body: string
    now: number
    expect: string
    signature: string
  }>
}

describe('signature vectors (packages/bridge-test-vectors/signature.json)', () => {
  for (const vector of vectors.cases) {
    it(`${vector.name} → ${vector.expect}`, () => {
      const verdict = verifySignature({
        token: vectors.token,
        method: vector.method,
        pathWithQuery: vector.path,
        rawBody: vector.body,
        timestamp: String(vector.timestamp),
        signature: vector.signature,
        now: vector.now,
        maxSkewSeconds: vectors.max_skew_seconds,
      })
      assert.equal(verdict, vector.expect)

      if (vector.expect === 'valid') {
        assert.equal(
          sign(vectors.token, vector.method, vector.path, vector.timestamp, vector.body),
          vector.signature.toLowerCase()
        )
      }
    })
  }
})

describe('signature unit', () => {
  const base = {
    token: 't',
    method: 'GET',
    pathWithQuery: '/x',
    rawBody: '',
    now: 1000,
  }

  it('payload format', () => {
    assert.equal(signaturePayload('post', '/a?b=1', 5, 'x'), `POST\n/a?b=1\n5\n${sha256Hex('x')}`)
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('missing token, signature or bad timestamp → unauthorized', () => {
    const sig = sign('t', 'GET', '/x', 1000, '')
    assert.equal(
      verifySignature({ ...base, token: '', timestamp: '1000', signature: sig }),
      'unauthorized'
    )
    assert.equal(
      verifySignature({ ...base, timestamp: '1000', signature: undefined }),
      'unauthorized'
    )
    assert.equal(verifySignature({ ...base, timestamp: undefined, signature: sig }), 'unauthorized')
    assert.equal(verifySignature({ ...base, timestamp: '10a0', signature: sig }), 'unauthorized')
    assert.equal(
      verifySignature({ ...base, timestamp: '1234567890123', signature: sig }),
      'unauthorized'
    )
    assert.equal(verifySignature({ ...base, timestamp: '-1000', signature: sig }), 'unauthorized')
    assert.equal(verifySignature({ ...base, timestamp: '1000', signature: sig }), 'valid')
  })

  it('non-hex / short signature → signature_invalid', () => {
    assert.equal(
      verifySignature({ ...base, timestamp: '1000', signature: 'zz' }),
      'signature_invalid'
    )
  })
})
