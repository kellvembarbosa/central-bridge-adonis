import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { FORBIDDEN_SEGMENTS, isForbiddenKey, sanitize } from '../src/core/sanitizer.ts'

// Standalone repo: ./test-vectors. Monorepo: ../bridge-test-vectors (canonical).
function vectorsFile(file: string) {
  const local = new URL(`../test-vectors/${file}`, import.meta.url)
  return existsSync(local) ? local : new URL(`../../bridge-test-vectors/${file}`, import.meta.url)
}

const vectors = JSON.parse(
  readFileSync(vectorsFile('sanitizer.json'), 'utf8')
) as {
  forbidden_segments: string[]
  cases: Array<{ name: string; input: unknown; allow: string[]; output: unknown }>
}

describe('sanitizer vectors (packages/bridge-test-vectors/sanitizer.json)', () => {
  it('forbidden segments match the shared list', () => {
    assert.deepEqual([...FORBIDDEN_SEGMENTS].sort(), [...vectors.forbidden_segments].sort())
  })

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      assert.deepEqual(sanitize(vector.input, vector.allow), vector.output)
    })
  }
})

describe('sanitizer unit', () => {
  it('segments: snake, camel, kebab and spaces', () => {
    for (const key of [
      'APIToken',
      'user password',
      'Senha',
      'client_secret',
      'CPF',
      'twoFactorRecoveryCodes',
    ]) {
      assert.equal(isForbiddenKey(key), true, key)
    }
    for (const key of ['documents_issued', 'tokens_used', 'hashtag', 'email', 'name']) {
      assert.equal(isForbiddenKey(key), false, key)
    }
  })

  it('list indexes are ignored in paths and input is not mutated', () => {
    const input = { items: [{ taker: { document: '1' } }], keep: new Date(0) }
    const output = sanitize(input, ['items.taker.document'])
    assert.deepEqual(output, input)
    assert.notEqual(output, input)
    assert.deepEqual(sanitize(input), { items: [{ taker: {} }], keep: new Date(0) })
    assert.deepEqual(input.items[0].taker, { document: '1' })
  })
})
