import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { CentralClient } from '../src/client.ts'
import {
  parsePaymentEvent,
  parsePaymentRecord,
  parsePlan,
  type PaymentEvent,
} from '../src/checkout.ts'
import { ValidationFailedError } from '../src/core/errors.ts'
import { verifySignature } from '../src/core/signature.ts'
import { ACTOR, TOKEN, startBridgeServer, type TestServer } from './helpers.ts'

const P = '/central-api/v1'
const NOW = 1_763_200_000

// Standalone repo: ./test-vectors. Monorepo: ../bridge-test-vectors (canonical).
function vectorsFile(file: string) {
  const local = new URL(`../test-vectors/${file}`, import.meta.url)
  return existsSync(local) ? local : new URL(`../../bridge-test-vectors/${file}`, import.meta.url)
}

const vectors = JSON.parse(readFileSync(vectorsFile('payment_event.json'), 'utf8')) as {
  plan_wire: unknown
  plan_parsed: unknown
  payment_wire: unknown
  payment_parsed: unknown
  event_wire: Record<string, unknown>
  event_parsed: unknown
  renewal_wire: Record<string, unknown>
  renewal_parsed: unknown
  prepaid_wire: Record<string, unknown>
  prepaid_parsed: unknown
  invalid_events: { why: string; wire: Record<string, unknown> }[]
}

describe('checkout vectors (bridge-test-vectors/payment_event.json)', () => {
  it('plan, payment and events parse to the camelCase shapes', () => {
    assert.deepEqual(parsePlan(vectors.plan_wire), vectors.plan_parsed)
    assert.deepEqual(parsePaymentRecord(vectors.payment_wire), vectors.payment_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.event_wire), vectors.event_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.renewal_wire), vectors.renewal_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.prepaid_wire), vectors.prepaid_parsed)
  })

  it('accessUntil: null when an older Central omits it, 422 when it is not a string', () => {
    const { access_until: _omitted, ...older } = vectors.payment_wire as Record<string, unknown>
    assert.equal(parsePaymentRecord(older).accessUntil, null)
    assert.throws(() => parsePaymentRecord({ ...older, access_until: 123 }), ValidationFailedError)
  })

  for (const bad of vectors.invalid_events) {
    it(`rejects: ${bad.why}`, () => {
      assert.throws(() => parsePaymentEvent(bad.wire), ValidationFailedError)
    })
  }
})

describe('POST payment-events (Central → product)', () => {
  const received: { event: PaymentEvent; actor: string }[] = []
  let s: TestServer
  before(
    async () =>
      (s = await startBridgeServer({
        handlers: {
          paymentEvent: (event, actor) => {
            received.push({ event, actor })
          },
        },
      }))
  )
  after(() => s.close())

  it('delivers the parsed event with the actor; announces payment_events', async () => {
    const res = await s.write(`${P}/payment-events`, vectors.event_wire, 'evt-key')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.deepEqual(received, [{ event: vectors.event_parsed, actor: ACTOR }])

    // Same event again (retry after a lost response): replayed, handler not called.
    const again = await s.write(`${P}/payment-events`, vectors.event_wire, 'evt-key')
    assert.equal(again.headers.get('x-idempotency-replayed'), 'true')
    assert.equal(received.length, 1)

    const health = await s.call('GET', `${P}/health`)
    assert.deepEqual(health.body.capabilities, ['payment_events'])
  })

  it('422 on an invalid event or a non-object body', async () => {
    const count = received.length
    const bad = await s.write(`${P}/payment-events`, vectors.invalid_events[0].wire, 'k-bad')
    assert.equal(bad.status, 422)
    assert.equal(bad.body.error.code, 'validation_failed')

    const notObject = await s.write(`${P}/payment-events`, '[1]', 'k-not-object')
    assert.equal(notObject.status, 422)
    assert.equal(received.length, count)
  })

  it('501 without the handler', async () => {
    const none = await startBridgeServer({ handlers: {} })
    try {
      const res = await none.write(`${P}/payment-events`, vectors.event_wire, 'k-none')
      assert.equal(res.status, 501)
      assert.equal(res.body.error.code, 'capability_unsupported')
    } finally {
      await none.close()
    }
  })
})

describe('CentralClient checkout (product → Central)', () => {
  interface Captured {
    url: string
    method: string
    headers: Record<string, string>
    body: string
  }

  function fakeCentral(respond: (req: Captured) => Response) {
    const seen: Captured[] = []
    const client = new CentralClient({
      baseUrl: 'https://central.test',
      token: TOKEN,
      product: 'demo',
      now: () => NOW,
      fetch: (async (input: URL | string, init: RequestInit = {}) => {
        const req: Captured = {
          url: String(input),
          method: String(init.method),
          headers: Object.fromEntries(
            Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
          ),
          body: typeof init.body === 'string' ? init.body : '',
        }
        seen.push(req)
        return respond(req)
      }) as typeof fetch,
    })
    return { client, seen }
  }

  it('listPlans, createPayment and getPayment map the wire shapes', async () => {
    const { client, seen } = fakeCentral((req) => {
      const path = new URL(req.url).pathname
      if (path === '/api/v1/plans') return Response.json({ data: [vectors.plan_wire] })
      return Response.json(
        { data: vectors.payment_wire },
        { status: req.method === 'POST' ? 201 : 200 }
      )
    })

    assert.deepEqual(await client.listPlans(), [vectors.plan_parsed])
    assert.deepEqual([seen[0].method, seen[0].url], ['GET', 'https://central.test/api/v1/plans'])

    const created = await client.createPayment(
      {
        plan: 'vitalicio',
        customer: { name: 'Ana Souza', email: 'ana@cliente.test', document: '52998224725' },
        productUserRef: '42',
        method: 'pix',
        tracking: { utm_source: 'google' },
      },
      'checkout-1'
    )
    assert.deepEqual(created, vectors.payment_parsed)

    const post = seen[1]
    assert.equal(post.url, 'https://central.test/api/v1/payments')
    assert.equal(post.headers['x-idempotency-key'], 'checkout-1')
    assert.equal(post.headers['x-central-product'], 'demo')
    assert.deepEqual(JSON.parse(post.body), {
      plan: 'vitalicio',
      customer: { name: 'Ana Souza', email: 'ana@cliente.test', document: '52998224725' },
      product_user_ref: '42',
      method: 'pix',
      tracking: { utm_source: 'google' },
    })
    assert.equal(
      verifySignature({
        token: TOKEN,
        method: 'POST',
        pathWithQuery: '/api/v1/payments',
        rawBody: post.body,
        timestamp: post.headers['x-central-timestamp'],
        signature: post.headers['x-central-signature'],
        now: NOW,
      }),
      'valid'
    )

    assert.deepEqual(await client.getPayment('7f6d/../x'), vectors.payment_parsed)
    assert.equal(new URL(seen[2].url).pathname, '/api/v1/payments/7f6d%2F..%2Fx')
  })

  it('createPayment omits optional fields that were not given', async () => {
    const { client, seen } = fakeCentral(() =>
      Response.json({ data: vectors.payment_wire }, { status: 201 })
    )
    await client.createPayment(
      { plan: 'mensal', customer: { name: 'Ana', email: 'ana@x.com' }, productUserRef: '7' },
      'k'
    )
    assert.deepEqual(JSON.parse(seen[0].body), {
      plan: 'mensal',
      customer: { name: 'Ana', email: 'ana@x.com' },
      product_user_ref: '7',
    })
  })

  it('surfaces Central errors (plan_unavailable)', async () => {
    const { client } = fakeCentral(() =>
      Response.json(
        { error: { code: 'plan_unavailable', message: 'Plano inexistente ou fora de venda.' } },
        { status: 422 }
      )
    )
    await assert.rejects(
      client.createPayment(
        { plan: 'x', customer: { name: 'A', email: 'a@b.c' }, productUserRef: '1' },
        'k'
      ),
      (error: any) => error.code === 'plan_unavailable' && error.status === 422
    )
  })
})
