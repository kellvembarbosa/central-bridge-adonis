import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ACTOR, deferred, startBridgeServer, TOKEN, type TestServer } from './helpers.ts'
import { fakeHandlers, type Calls } from './fixtures.ts'
import { BRIDGE_ERRORS, IDEMPOTENCY_IN_PROGRESS_MESSAGE } from '../src/core/errors.ts'
import { BRIDGE_VERSION } from '../src/version.ts'

const P = '/central-api/v1'

function assertError(
  res: { status: number; body: any },
  code: keyof typeof BRIDGE_ERRORS,
  message?: string
) {
  assert.equal(res.status, BRIDGE_ERRORS[code].status, JSON.stringify(res.body))
  assert.equal(res.body.error.code, code)
  assert.equal(res.body.error.message, message ?? BRIDGE_ERRORS[code].message)
  assert.deepEqual(Object.keys(res.body), ['error'])
}

describe('gate: enabled / IP / signature', () => {
  it('disabled → 404 not_found on every route, even with a bad IP', async () => {
    const s = await startBridgeServer({ enabled: false, allowedIps: '10.9.9.9' })
    try {
      assertError(await s.call('GET', `${P}/health`), 'not_found')
      assertError(await s.write(`${P}/users/u1/suspend`, { reason: 'x' }), 'not_found')
    } finally {
      await s.close()
    }
  })

  it('IP outside the allowlist → 403 ip_not_allowed (before signature)', async () => {
    const s = await startBridgeServer({ allowedIps: '10.0.0.1, 10.0.0.2' })
    try {
      assertError(await s.call('GET', `${P}/health`, { unsigned: true }), 'ip_not_allowed')
      assertError(await s.call('GET', `${P}/health`), 'ip_not_allowed')
    } finally {
      await s.close()
    }
  })

  it('IP in the allowlist passes (IPv4-mapped IPv6 normalized)', async () => {
    const s = await startBridgeServer({ allowedIps: ['10.0.0.1', '127.0.0.1'] })
    try {
      assert.equal((await s.call('GET', `${P}/health`)).status, 200)
    } finally {
      await s.close()
    }
  })

  describe('headers and HMAC', () => {
    let s: TestServer
    before(async () => (s = await startBridgeServer({ handlers: fakeHandlers() })))
    after(() => s.close())

    it('missing headers → 401 unauthorized', async () => {
      assertError(await s.call('GET', `${P}/health`, { unsigned: true }), 'unauthorized')
      assertError(
        await s.call('GET', `${P}/health`, { headers: { 'X-Central-Signature': undefined } }),
        'unauthorized'
      )
      assertError(
        await s.call('GET', `${P}/health`, { headers: { 'X-Central-Timestamp': undefined } }),
        'unauthorized'
      )
    })

    it('malformed timestamp → 401 unauthorized', async () => {
      assertError(await s.call('GET', `${P}/health`, { timestamp: '17632x0000' }), 'unauthorized')
      assertError(
        await s.call('GET', `${P}/health`, { timestamp: '1234567890123' }),
        'unauthorized'
      )
    })

    it('clock skew > 300s → 401 timestamp_skew (both directions)', async () => {
      const now = Math.floor(Date.now() / 1000)
      assertError(await s.call('GET', `${P}/health`, { timestamp: now - 400 }), 'timestamp_skew')
      assertError(await s.call('GET', `${P}/health`, { timestamp: now + 400 }), 'timestamp_skew')
    })

    it('wrong token → 401 signature_invalid', async () => {
      assertError(await s.call('GET', `${P}/health`, { token: 'other' }), 'signature_invalid')
    })

    it('signature is checked against the RAW body', async () => {
      // same JSON semantics, different bytes → must fail
      assertError(
        await s.call('POST', `${P}/users/u1/suspend`, {
          body: '{"reason": "x"}',
          signBody: '{"reason":"x"}',
          headers: { 'X-Central-Actor': ACTOR, 'X-Idempotency-Key': 'raw-1' },
        }),
        'signature_invalid'
      )
      // exact raw bytes (with odd spacing) pass
      const ok = await s.call('POST', `${P}/users/u1/suspend`, {
        body: '{ "reason" :  "x" }',
        headers: { 'X-Central-Actor': ACTOR, 'X-Idempotency-Key': 'raw-2' },
      })
      assert.equal(ok.status, 200)
    })

    it('signature is checked against the RAW path + query', async () => {
      const path = `${P}/users?q=ana%40x.com&page=2`
      assertError(
        await s.call('GET', path, { signPath: `${P}/users?q=ana@x.com&page=2` }),
        'signature_invalid'
      )
      assertError(await s.call('GET', path, { signPath: `${P}/users` }), 'signature_invalid')
      assert.equal((await s.call('GET', path)).status, 200)
    })

    it('uppercase hex signature is accepted', async () => {
      const { sign } = await import('../src/core/signature.ts')
      const ts = Math.floor(Date.now() / 1000)
      const res = await s.call('GET', `${P}/health`, {
        timestamp: ts,
        headers: { 'X-Central-Signature': sign(TOKEN, 'GET', `${P}/health`, ts, '').toUpperCase() },
      })
      assert.equal(res.status, 200)
    })

    it('empty token in config → 401 unauthorized', async () => {
      const s2 = await startBridgeServer({ token: '' })
      try {
        assertError(await s2.call('GET', `${P}/health`), 'unauthorized')
      } finally {
        await s2.close()
      }
    })

    it('unknown path under the prefix → 404 not_found (after auth)', async () => {
      assertError(await s.call('GET', `${P}/nope`), 'not_found')
      assertError(await s.call('GET', `${P}/nope`, { unsigned: true }), 'unauthorized')
    })

    it('echoes X-Central-Request-Id and disables caching', async () => {
      const res = await s.call('GET', `${P}/health`, {
        headers: { 'X-Central-Request-Id': 'req-9' },
      })
      assert.equal(res.headers.get('x-central-request-id'), 'req-9')
      assert.equal(res.headers.get('cache-control'), 'no-store')
    })
  })
})

describe('health and capabilities', () => {
  it('all handlers → every capability', async () => {
    const s = await startBridgeServer({ handlers: fakeHandlers(), version: '9.9.9' })
    try {
      const res = await s.call('GET', `${P}/health`)
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, {
        version: '9.9.9',
        product: 'demo',
        capabilities: [
          'payment_owner',
          'subscriptions',
          'users_search',
          'user_detail',
          'change_plan',
          'password_reset',
          'suspend',
          'metrics',
          'invoices',
          'payment_events',
        ],
      })
    } finally {
      await s.close()
    }
  })

  it('invoices needs both handlers; suspend needs suspend + unsuspend; default version', async () => {
    const all = fakeHandlers()
    const s = await startBridgeServer({
      handlers: {
        invoiceRequest: all.invoiceRequest,
        suspend: all.suspend,
        findUser: all.findUser,
      },
    })
    try {
      const res = await s.call('GET', `${P}/health`)
      assert.deepEqual(res.body, {
        version: BRIDGE_VERSION,
        product: 'demo',
        capabilities: ['user_detail'],
      })
    } finally {
      await s.close()
    }
  })

  it('lazy handlers loader (config-file style)', async () => {
    const s = await startBridgeServer({
      handlers: async () => ({ default: { metrics: async () => [] } }),
    })
    try {
      const res = await s.call('GET', `${P}/health`)
      assert.deepEqual(res.body.capabilities, ['metrics'])
    } finally {
      await s.close()
    }
  })
})

describe('501 capability_unsupported', () => {
  let s: TestServer
  before(async () => (s = await startBridgeServer({ handlers: {} })))
  after(() => s.close())

  const reads = [
    `${P}/payments/stripe/pi_1/owner`,
    `${P}/payments/stripe/pi_1/invoice-request`,
    `${P}/subscriptions`,
    `${P}/users?q=a`,
    `${P}/users/u1`,
    `${P}/metrics?from=2026-11-01&to=2026-11-02`,
  ]
  for (const path of reads) {
    it(`GET ${path}`, async () => assertError(await s.call('GET', path), 'capability_unsupported'))
  }

  const writes: Array<[string, unknown]> = [
    [`${P}/users/u1/plan`, { plan: 'pro', until: null, reason: 'x' }],
    [`${P}/users/u1/password-reset`, ''],
    [`${P}/users/u1/suspend`, { reason: 'x' }],
    [`${P}/users/u1/unsuspend`, { reason: 'x' }],
    [`${P}/invoices`, { invoice_id: 'i1' }],
    [`${P}/payment-events`, { id: 'evt_1' }],
  ]
  for (const [path, body] of writes) {
    it(`POST ${path}`, async () => assertError(await s.write(path, body), 'capability_unsupported'))
  }

  it('501 is not stored for idempotency', async () => {
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k-501'),
      'capability_unsupported'
    )
    const again = await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k-501')
    assert.equal(again.headers.get('x-idempotency-replayed'), null)
  })
})

describe('routes happy path (snake_case wire + sanitizer)', () => {
  let s: TestServer
  const calls: Calls = {}
  before(async () => (s = await startBridgeServer({ handlers: fakeHandlers(calls) })))
  after(() => s.close())

  it('GET payments/{provider}/{id}/owner', async () => {
    const res = await s.call('GET', `${P}/payments/stripe/pi_1/owner`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      owned: true,
      user_ref: 'u_42',
      kind: 'subscription',
      local_status: 'paid',
    })
    assert.deepEqual(calls.paymentOwner.at(-1), ['stripe', 'pi_1'])
  })

  it('GET payments/{provider}/{id}/invoice-request keeps taker.document only', async () => {
    const res = await s.call('GET', `${P}/payments/asaas/pay_9/invoice-request`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      requested: true,
      request_ref: 'req_1',
      email: 'ana@x.com',
      service_description: 'Assinatura Pro',
      taker: { document: '12345678000195', name: 'ACME' },
    })
    assert.deepEqual(calls.invoiceRequest.at(-1), ['asaas', 'pay_9'])
  })

  it('GET subscriptions?status=&page=', async () => {
    const res = await s.call('GET', `${P}/subscriptions?status=active&page=3`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      data: [
        {
          ref: 's_1',
          user_ref: 'u_42',
          provider: 'stripe',
          provider_subscription_id: 'sub_123',
          status: 'active',
          plan: 'pro',
          amount_cents: 4990,
          currency: 'BRL',
          interval: 'month',
          current_period_end: '2026-12-01T00:00:00.000Z',
        },
      ],
      page: 3,
      per_page: 25,
      has_more: true,
    })
    assert.deepEqual(calls.subscriptions.at(-1), ['active', 3, 25])

    await s.call('GET', `${P}/subscriptions`)
    assert.deepEqual(calls.subscriptions.at(-1), [null, 1, 25])
  })

  it('GET subscriptions validation', async () => {
    assertError(
      await s.call('GET', `${P}/subscriptions?status=bogus`),
      'validation_failed',
      'Dados inválidos: "status" deve ser um de trialing, active, past_due, canceled, expired, paused.'
    )
    assert.equal((await s.call('GET', `${P}/subscriptions?page=0`)).status, 422)
    assert.equal((await s.call('GET', `${P}/subscriptions?page=abc`)).status, 422)
  })

  it('GET users?q=&page= (decoded query reaches the handler)', async () => {
    const res = await s.call('GET', `${P}/users?q=ana%40x.com&page=2`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      data: [
        {
          ref: 'u_42',
          email: 'ana@x.com',
          name: 'Ana',
          plan: 'pro',
          suspended: false,
          created_at: '2026-01-01T00:00:00.000Z',
          last_seen_at: null,
        },
      ],
      page: 2,
      per_page: 25,
      has_more: false,
    })
    assert.deepEqual(calls.searchUsers.at(-1), ['ana@x.com', 2, 25])
    assert.equal((await s.call('GET', `${P}/users?q=${'a'.repeat(192)}`)).status, 422)
    assert.equal((await s.call('GET', `${P}/users?q=${'a'.repeat(191)}`)).status, 200)
  })

  it('GET users/{ref} → UserDetail, secrets dropped', async () => {
    const res = await s.call('GET', `${P}/users/u%2042`)
    assert.equal(res.status, 200)
    assert.deepEqual(calls.findUser.at(-1), ['u 42'])
    assert.deepEqual(res.body, {
      ref: 'u 42',
      email: 'ana@x.com',
      name: 'Ana',
      plan: 'pro',
      suspended: false,
      created_at: '2026-01-01T00:00:00.000-03:00',
      last_seen_at: '2026-11-14T10:00:00.000Z',
      limits: { projects: 10, storage: '5GB', seats: null },
      usage: { projects: 3, documents_issued: 7 },
      subscriptions: [
        {
          ref: 's_1',
          user_ref: 'u_42',
          provider: 'stripe',
          provider_subscription_id: 'sub_123',
          status: 'active',
          plan: 'pro',
          amount_cents: 4990,
          currency: 'BRL',
          interval: 'month',
          current_period_end: '2026-12-01T00:00:00.000Z',
        },
      ],
      recent_events: [{ type: 'login', at: '2026-11-14T10:00:00Z', description: null }],
    })
  })

  it('GET users/{ref} unknown → 404 not_found', async () => {
    const res = await s.call('GET', `${P}/users/missing`)
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'not_found')
  })

  it('GET metrics?from=&to=', async () => {
    const res = await s.call('GET', `${P}/metrics?from=2026-11-01&to=2026-11-07`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      data: [{ date: '2026-11-01', metrics: { new_users: 3, revenueCents: 1000 } }],
    })
    assert.deepEqual(calls.metrics.at(-1), ['2026-11-01', '2026-11-07'])
    for (const q of [
      '',
      '?from=2026-11-01',
      '?from=2026-02-30&to=2026-03-01',
      '?from=2026-11-08&to=2026-11-07',
      '?from=01/11/2026&to=2026-11-07',
    ]) {
      assert.equal((await s.call('GET', `${P}/metrics${q}`)).status, 422, q)
    }
  })

  it('POST users/{ref}/plan', async () => {
    const res = await s.write(`${P}/users/u_42/plan`, {
      plan: 'pro',
      until: '2027-01-31',
      reason: 'Cortesia',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.deepEqual(calls.changePlan.at(-1), [
      'u_42',
      { plan: 'pro', until: '2027-01-31', reason: 'Cortesia' },
      ACTOR,
    ])

    await s.write(`${P}/users/u_42/plan`, { plan: 'free', reason: 'Downgrade' })
    assert.deepEqual(calls.changePlan.at(-1), [
      'u_42',
      { plan: 'free', until: null, reason: 'Downgrade' },
      ACTOR,
    ])
  })

  it('POST users/{ref}/plan validation and handler errors', async () => {
    assert.equal((await s.write(`${P}/users/u_42/plan`, { until: null, reason: 'x' })).status, 422)
    assert.equal(
      (await s.write(`${P}/users/u_42/plan`, { plan: 'x'.repeat(65), reason: 'x' })).status,
      422
    )
    assert.equal(
      (await s.write(`${P}/users/u_42/plan`, { plan: 'pro', until: '31/01/2027', reason: 'x' }))
        .status,
      422
    )
    assert.equal(
      (await s.write(`${P}/users/u_42/plan`, { plan: 'pro', reason: 'x'.repeat(501) })).status,
      422
    )
    assert.equal((await s.write(`${P}/users/u_42/plan`, '[1,2]')).status, 422)
    assertError(
      await s.write(`${P}/users/u_42/plan`, { plan: 'unknown', reason: 'x' }),
      'validation_failed',
      'Plano inexistente.'
    )
    const missing = await s.write(`${P}/users/missing/plan`, { plan: 'pro', reason: 'x' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'not_found')
  })

  it('POST users/{ref}/password-reset', async () => {
    const res = await s.write(`${P}/users/u_42/password-reset`, '')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, message: 'E-mail de redefinição enviado.' })
    assert.deepEqual(calls.sendPasswordReset.at(-1), ['u_42', ACTOR])
  })

  it('POST users/{ref}/suspend and unsuspend', async () => {
    const a = await s.write(`${P}/users/u_42/suspend`, { reason: 'Fraude confirmada' })
    assert.deepEqual([a.status, a.body], [200, { ok: true }])
    assert.deepEqual(calls.suspend.at(-1), ['u_42', 'Fraude confirmada', ACTOR])

    const b = await s.write(`${P}/users/u_42/unsuspend`, { reason: 'Revisado' })
    assert.deepEqual([b.status, b.body], [200, { ok: true }])
    assert.deepEqual(calls.unsuspend.at(-1), ['u_42', 'Revisado', ACTOR])

    assert.equal((await s.write(`${P}/users/u_42/suspend`, {})).status, 422)
  })

  it('POST invoices (InvoiceDelivery snake_case → camelCase)', async () => {
    const delivery = {
      invoice_id: 77,
      request_ref: 'req_1',
      provider: 'stripe',
      payment_id: 'pi_1',
      status: 'issued',
      number: '123',
      access_key: 'NFSe123',
      issued_at: '2026-11-15T12:00:00Z',
      pdf_url: 'https://central/x.pdf',
      xml_url: 'https://central/x.xml',
      message: null,
      view_url: 'https://central/v/77',
    }
    const res = await s.write(`${P}/invoices`, delivery)
    assert.deepEqual([res.status, res.body], [200, { ok: true }])
    assert.deepEqual(calls.receiveInvoice.at(-1), [
      {
        invoiceId: '77',
        requestRef: 'req_1',
        provider: 'stripe',
        paymentId: 'pi_1',
        status: 'issued',
        number: '123',
        accessKey: 'NFSe123',
        issuedAt: '2026-11-15T12:00:00Z',
        pdfUrl: 'https://central/x.pdf',
        xmlUrl: 'https://central/x.xml',
        message: null,
        viewUrl: 'https://central/v/77',
      },
      ACTOR,
    ])
    assert.equal((await s.write(`${P}/invoices`, { ...delivery, status: 'draft' })).status, 422)
    assert.equal(
      (await s.write(`${P}/invoices`, { ...delivery, invoice_id: undefined })).status,
      422
    )
  })
})

describe('errors from handlers', () => {
  it('unhandled exception → 500 internal_error without details', async () => {
    const s = await startBridgeServer({
      handlers: {
        async paymentOwner() {
          throw new Error('db exploded: password=hunter2')
        },
      },
    })
    try {
      assertError(await s.call('GET', `${P}/payments/stripe/x/owner`), 'internal_error')
    } finally {
      await s.close()
    }
  })
})

describe('writes: actor and idempotency', () => {
  let s: TestServer
  const calls: Calls = {}
  let gate = deferred()
  let failNext = false
  const handlers = fakeHandlers(calls)
  before(async () => {
    s = await startBridgeServer({
      handlers: {
        ...handlers,
        async suspend(ref, reason, actor) {
          if (failNext) {
            failNext = false
            throw new Error('boom')
          }
          if (reason === 'slow') await gate.promise
          return handlers.suspend!(ref, reason, actor)
        },
      },
    })
  })
  after(() => s.close())

  it('missing or invalid X-Central-Actor → 422 missing_actor', async () => {
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k', {
        'X-Central-Actor': undefined,
      }),
      'missing_actor'
    )
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k', {
        'X-Central-Actor': 'not-an-email',
      }),
      'missing_actor'
    )
  })

  it('missing or oversized X-Idempotency-Key → 422 validation_failed', async () => {
    const r1 = await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k', {
      'X-Idempotency-Key': undefined,
    })
    assert.equal(r1.status, 422)
    assert.equal(r1.body.error.code, 'validation_failed')
    const r2 = await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k'.repeat(129))
    assert.equal(r2.body.error.code, 'validation_failed')
    const r3 = await s.write(`${P}/users/u1/suspend`, { reason: 'x' }, 'k'.repeat(128))
    assert.equal(r3.status, 200)
  })

  it('same key + same body → stored response replayed with X-Idempotency-Replayed', async () => {
    const before = calls.suspend?.length ?? 0
    const first = await s.write(`${P}/users/u1/suspend`, { reason: 'once' }, 'idem-1')
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('x-idempotency-replayed'), null)

    const second = await s.write(`${P}/users/u1/suspend`, { reason: 'once' }, 'idem-1')
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, { ok: true })
    assert.equal(second.headers.get('x-idempotency-replayed'), 'true')
    assert.equal(calls.suspend.length, before + 1)
  })

  it('same key + different body → 409 idempotency_conflict', async () => {
    await s.write(`${P}/users/u1/suspend`, { reason: 'a' }, 'idem-2')
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'b' }, 'idem-2'),
      'idempotency_conflict'
    )
    // same body on another path is another fingerprint
    assertError(
      await s.write(`${P}/users/u1/unsuspend`, { reason: 'a' }, 'idem-2'),
      'idempotency_conflict'
    )
  })

  it('same key still running → 409 with in-progress message', async () => {
    gate = deferred()
    const slow = s.write(`${P}/users/u1/suspend`, { reason: 'slow' }, 'idem-3')
    await new Promise((r) => setTimeout(r, 50))
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'slow' }, 'idem-3'),
      'idempotency_conflict',
      IDEMPOTENCY_IN_PROGRESS_MESSAGE
    )
    gate.resolve()
    assert.equal((await slow).status, 200)
    const replay = await s.write(`${P}/users/u1/suspend`, { reason: 'slow' }, 'idem-3')
    assert.equal(replay.headers.get('x-idempotency-replayed'), 'true')
  })

  it('5xx responses are not stored; 4xx are', async () => {
    failNext = true
    assertError(
      await s.write(`${P}/users/u1/suspend`, { reason: 'retry' }, 'idem-4'),
      'internal_error'
    )
    const retry = await s.write(`${P}/users/u1/suspend`, { reason: 'retry' }, 'idem-4')
    assert.equal(retry.status, 200)
    assert.equal(retry.headers.get('x-idempotency-replayed'), null)

    const invalid = await s.write(`${P}/users/u1/suspend`, {}, 'idem-5')
    assert.equal(invalid.status, 422)
    const replayed = await s.write(`${P}/users/u1/suspend`, {}, 'idem-5')
    assert.equal(replayed.status, 422)
    assert.equal(replayed.headers.get('x-idempotency-replayed'), 'true')
    assert.deepEqual(replayed.body, invalid.body)
  })
})
