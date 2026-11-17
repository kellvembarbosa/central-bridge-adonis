import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CentralBridge } from '../src/bridge.ts'
import { defineConfig, stores } from '../src/define_config.ts'
import { sign } from '../src/core/signature.ts'
import { MemoryIdempotencyStore, idempotencyFingerprint } from '../src/core/idempotency.ts'
import { RedisIdempotencyStore, type RedisLike } from '../src/redis_store.ts'
import type { BridgeRequest } from '../src/types.ts'
import { BRIDGE_VERSION } from '../src/version.ts'

const TOKEN = 'tok'
const NOW = 1_763_200_000

function request(
  method: string,
  url: string,
  rawBody = '',
  extra: Record<string, string> = {}
): BridgeRequest {
  const headers: Record<string, string> = {
    'x-central-timestamp': String(NOW),
    'x-central-signature': sign(TOKEN, method, url, NOW, rawBody),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  }
  return {
    method,
    url,
    rawBody,
    ip: '127.0.0.1',
    params: { ref: 'u1' },
    header: (n) => headers[n.toLowerCase()],
  }
}

class FakeRedis implements RedisLike {
  data = new Map<string, string>()
  ttl = new Map<string, number>()
  async get(key: string) {
    return this.data.get(key) ?? null
  }
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes('NX') && this.data.has(key)) return null
    this.data.set(key, value)
    const ex = args.indexOf('EX')
    if (ex !== -1) this.ttl.set(key, Number(args[ex + 1]))
    return 'OK'
  }
  async del(...keys: string[]) {
    let n = 0
    for (const k of keys) if (this.data.delete(k)) n++
    return n
  }
}

describe('defineConfig', () => {
  it('fills contract defaults and normalizes input', () => {
    const config = defineConfig({
      allowedIps: ' 1.1.1.1 , ,2.2.2.2',
      prefix: 'central-api/v1/',
      token: ' t ',
    })
    assert.equal(config.enabled, false)
    assert.equal(config.token, 't')
    assert.equal(config.prefix, '/central-api/v1')
    assert.deepEqual(config.allowedIps, ['1.1.1.1', '2.2.2.2'])
    assert.equal(config.maxSkewSeconds, 300)
    assert.equal(config.idempotencyTtlHours, 24)
    assert.equal(config.perPage, 25)
    assert.equal(config.version, BRIDGE_VERSION)
    assert.ok(config.idempotencyStore instanceof MemoryIdempotencyStore)
    assert.deepEqual(defineConfig(config), config)
  })
})

describe('CentralBridge (framework-free)', () => {
  it('dispatch authenticates then executes', async () => {
    const bridge = new CentralBridge(
      { enabled: true, token: TOKEN, product: 'p' },
      { now: () => NOW }
    )
    const ok = await bridge.dispatch('health', request('GET', '/central-api/v1/health'))
    assert.deepEqual(ok, {
      status: 200,
      body: { version: BRIDGE_VERSION, product: 'p', capabilities: [] },
      headers: {},
    })
    const bad = await bridge.dispatch('health', {
      ...request('GET', '/central-api/v1/health'),
      url: '/central-api/v1/health?x=1',
    })
    assert.equal(bad.status, 401)
  })

  it('logs unexpected errors and answers 500 without detail', async () => {
    const logged: unknown[] = []
    const bridge = new CentralBridge(
      {
        enabled: true,
        token: TOKEN,
        handlers: {
          metrics() {
            throw new Error('secret detail')
          },
        },
      },
      { now: () => NOW }
    )
    const req = {
      ...request('GET', '/central-api/v1/metrics?from=2026-01-01&to=2026-01-02'),
      logger: { error: (o: unknown) => logged.push(o) },
    }
    const res = await bridge.dispatch('metrics', req)
    assert.equal(res.status, 500)
    assert.equal(JSON.stringify(res.body).includes('secret'), false)
    assert.equal(logged.length, 1)
  })

  it('idempotency store failure → 500 internal_error', async () => {
    const bridge = new CentralBridge(
      {
        enabled: true,
        token: TOKEN,
        handlers: { suspend: async () => {}, unsuspend: async () => {} },
        idempotencyStore: async () => {
          throw new Error('redis down')
        },
      },
      { now: () => NOW }
    )
    const res = await bridge.dispatch(
      'suspend',
      request('POST', '/central-api/v1/users/u1/suspend', '{"reason":"x"}', {
        'X-Central-Actor': 'a@b.co',
        'X-Idempotency-Key': 'k',
      })
    )
    assert.equal(res.status, 500)
  })

  it('works with a lazily resolved Redis-like store', async () => {
    const redis = new FakeRedis()
    const bridge = new CentralBridge(
      {
        enabled: true,
        token: TOKEN,
        handlers: { suspend: async () => {}, unsuspend: async () => {} },
        idempotencyStore: () => stores.redisClient(redis),
      },
      { now: () => NOW }
    )
    const req = () =>
      request('POST', '/central-api/v1/users/u1/suspend', '{"reason":"x"}', {
        'X-Central-Actor': 'a@b.co',
        'X-Idempotency-Key': 'k1',
      })
    assert.equal((await bridge.dispatch('suspend', req())).status, 200)
    const replay = await bridge.dispatch('suspend', req())
    assert.equal(replay.headers['X-Idempotency-Replayed'], 'true')
    assert.equal(redis.ttl.get('central_bridge:idempotency:k1'), 24 * 3600)
    assert.equal(redis.data.has('central_bridge:idempotency:lock:k1'), false)
  })
})

describe('idempotency stores', () => {
  it('fingerprint = sha256(METHOD\\npath\\nrawBody)', () => {
    assert.equal(
      idempotencyFingerprint('post', '/a', 'b'),
      idempotencyFingerprint('POST', '/a', 'b')
    )
    assert.notEqual(
      idempotencyFingerprint('POST', '/a', 'b'),
      idempotencyFingerprint('POST', '/a', 'c')
    )
  })

  it('memory store: ttl, lock and release', async () => {
    let now = 0
    const store = new MemoryIdempotencyStore({ now: () => now })
    await store.set('k', { fingerprint: 'f', status: 200, body: { ok: true } }, 10)
    assert.deepEqual(await store.get('k'), { fingerprint: 'f', status: 200, body: { ok: true } })
    now = 10_000
    assert.equal(await store.get('k'), null)

    const release = await store.lock('l', 5)
    assert.ok(release)
    assert.equal(await store.lock('l', 5), null)
    await release()
    const again = await store.lock('l', 5)
    assert.ok(again)
    now += 6_000
    assert.ok(await store.lock('l', 5), 'expired lock can be taken')
  })

  it('redis store: SET NX lock owned by the holder', async () => {
    const redis = new FakeRedis()
    const store = new RedisIdempotencyStore(redis, { prefix: 'p:' })
    const release = await store.lock('k', 30)
    assert.ok(release)
    assert.equal(await store.lock('k', 30), null)
    assert.equal(redis.ttl.get('p:lock:k'), 30)
    // someone else took the lock after expiry: release must not delete it
    redis.data.set('p:lock:k', 'other-owner')
    await release()
    assert.equal(redis.data.get('p:lock:k'), 'other-owner')

    await store.set('k', { fingerprint: 'f', status: 422, body: { error: {} } }, 60)
    assert.deepEqual(await store.get('k'), { fingerprint: 'f', status: 422, body: { error: {} } })
    assert.equal(await store.get('none'), null)
  })

  it('redis store uses EVAL compare-and-delete when available', async () => {
    const redis = new FakeRedis() as FakeRedis & { eval: RedisLike['eval'] }
    const evals: unknown[][] = []
    redis.eval = async (...args) => {
      evals.push(args)
      return 1
    }
    const release = await new RedisIdempotencyStore(redis).lock('k', 30)
    await release!()
    assert.equal(evals.length, 1)
    assert.equal(evals[0][2], 'central_bridge:idempotency:lock:k')
  })
})
