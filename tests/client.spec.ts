import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CentralApiError, CentralClient } from '../src/client.ts'
import { verifySignature } from '../src/core/signature.ts'

const TOKEN = 'cbt_test_token_0123456789abcdef'
const NOW = 1_763_200_000

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function stubFetch(responder: (req: Captured) => Response) {
  const captured: Captured[] = []
  const fetchStub = (async (input: URL | string, init: RequestInit = {}) => {
    const req: Captured = {
      url: String(input),
      method: String(init.method),
      headers: Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
      ),
      body: typeof init.body === 'string' ? init.body : '',
    }
    captured.push(req)
    return responder(req)
  }) as typeof fetch
  return { fetchStub, captured }
}

function client(fetchStub: typeof fetch, baseUrl = 'https://central.test/') {
  return new CentralClient({
    baseUrl,
    token: TOKEN,
    product: 'danfe',
    fetch: fetchStub,
    now: () => NOW,
  })
}

function assertSigned(req: Captured) {
  const url = new URL(req.url)
  assert.equal(req.headers['x-central-product'], 'danfe')
  assert.equal(req.headers['x-central-timestamp'], String(NOW))
  assert.equal(
    verifySignature({
      token: TOKEN,
      method: req.method,
      pathWithQuery: url.pathname + url.search,
      rawBody: req.body,
      timestamp: req.headers['x-central-timestamp'],
      signature: req.headers['x-central-signature'],
      now: NOW,
    }),
    'valid'
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('CentralClient', () => {
  it('issueInvoice: signed POST, snake_case body, idempotency key', async () => {
    const { fetchStub, captured } = stubFetch(() =>
      json({ data: { id: 1, status: 'pending' } }, 201)
    )
    const result = await client(fetchStub).issueInvoice(
      {
        taker: { document: '12345678000195', name: 'ACME', email: 'a@acme.com' },
        amountCents: 4990,
        description: 'Assinatura Pro',
        serviceCode: '01.07',
        reference: 'pi_1',
      },
      'idem-1'
    )
    assert.deepEqual(result, { data: { id: 1, status: 'pending' } })
    const [req] = captured
    assert.equal(req.method, 'POST')
    assert.equal(req.url, 'https://central.test/api/v1/invoices')
    assert.equal(req.headers['x-idempotency-key'], 'idem-1')
    assert.equal(req.headers['content-type'], 'application/json')
    assert.equal(req.headers['x-central-actor'], undefined)
    assert.deepEqual(JSON.parse(req.body), {
      taker: { document: '12345678000195', name: 'ACME', email: 'a@acme.com' },
      amount_cents: 4990,
      description: 'Assinatura Pro',
      service_code: '01.07',
      reference: 'pi_1',
    })
    assertSigned(req)
  })

  it('GET endpoints: list (query signed), get, pdf (Buffer), xml (string)', async () => {
    const { fetchStub, captured } = stubFetch((req) => {
      if (req.url.endsWith('/pdf')) return new Response(new Uint8Array([37, 80, 68, 70]))
      if (req.url.endsWith('/xml')) return new Response('<NFSe/>')
      return json({ data: [] })
    })
    const c = client(fetchStub, 'https://central.test/base')
    assert.deepEqual(await c.listInvoices(2), { data: [] })
    assert.deepEqual(await c.getInvoice(7), { data: [] })
    const pdf = await c.invoicePdf(7)
    assert.ok(Buffer.isBuffer(pdf))
    assert.equal(pdf.toString('latin1'), '%PDF')
    assert.equal(await c.invoiceXml('7'), '<NFSe/>')

    assert.deepEqual(
      captured.map((r) => [r.method, r.url]),
      [
        ['GET', 'https://central.test/base/api/v1/invoices?page=2'],
        ['GET', 'https://central.test/base/api/v1/invoices/7'],
        ['GET', 'https://central.test/base/api/v1/invoices/7/pdf'],
        ['GET', 'https://central.test/base/api/v1/invoices/7/xml'],
      ]
    )
    for (const req of captured) {
      assertSigned(req)
      assert.equal(req.body, '')
      assert.equal(req.headers['x-idempotency-key'], undefined)
    }
  })

  it('cancelInvoice: signed POST with reason', async () => {
    const { fetchStub, captured } = stubFetch(() => json({ data: { id: 7, status: 'canceled' } }))
    await client(fetchStub).cancelInvoice(7, 'Emitida com valor errado', 'idem-2')
    assert.equal(captured[0].url, 'https://central.test/api/v1/invoices/7/cancel')
    assert.deepEqual(JSON.parse(captured[0].body), { reason: 'Emitida com valor errado' })
    assert.equal(captured[0].headers['x-idempotency-key'], 'idem-2')
    assertSigned(captured[0])
  })

  it('error envelope → CentralApiError {code, message, status}', async () => {
    const { fetchStub } = stubFetch(() =>
      json({ error: { code: 'idempotency_conflict', message: 'Chave já usada.' } }, 409)
    )
    await assert.rejects(client(fetchStub).getInvoice(1), (error: unknown) => {
      assert.ok(error instanceof CentralApiError)
      assert.equal(error.code, 'idempotency_conflict')
      assert.equal(error.message, 'Chave já usada.')
      assert.equal(error.status, 409)
      return true
    })
  })

  it('non-JSON error and network failure', async () => {
    const { fetchStub } = stubFetch(() => new Response('Bad Gateway', { status: 502 }))
    await assert.rejects(client(fetchStub).listInvoices(), { code: 'internal_error', status: 502 })

    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await assert.rejects(client(failing).listInvoices(), { code: 'network_error', status: 0 })
  })

  it('writes require an idempotency key; config is validated', async () => {
    const { fetchStub, captured } = stubFetch(() => json({}))
    await assert.rejects(client(fetchStub).cancelInvoice(1, 'x'.repeat(20), ''), {
      code: 'validation_failed',
    })
    assert.equal(captured.length, 0)
    assert.throws(
      () => new CentralClient({ baseUrl: '', token: 't', product: 'p' }),
      CentralApiError
    )
    assert.throws(
      () => new CentralClient({ baseUrl: 'https://x', token: '', product: 'p' }),
      CentralApiError
    )
  })
})
