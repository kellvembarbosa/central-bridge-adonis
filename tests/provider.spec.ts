import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppFactory } from '@adonisjs/core/factories/app'
import { ServerFactory } from '@adonisjs/core/factories/http'
import CentralBridgeProvider from '../providers/central_bridge_provider.ts'
import { defineConfig } from '../src/define_config.ts'

describe('CentralBridgeProvider', () => {
  it('registers every route from config/central_bridge', async () => {
    const app = new AppFactory().create(new URL('../', import.meta.url))
    await app.init()
    const router = new ServerFactory().merge({ app }).create().getRouter()
    const fakeApp = {
      config: {
        get: (key: string) =>
          key === 'central_bridge' ? defineConfig({ enabled: true }) : undefined,
      },
      container: { make: async (key: string) => (key === 'router' ? router : undefined) },
    }
    await new CentralBridgeProvider(fakeApp as any).boot()
    router.commit()

    const routes = Object.values(router.toJSON())
      .flat()
      .map(
        (route: any) =>
          `${route.methods.filter((m: string) => m !== 'HEAD').join('|')} ${route.pattern}`
      )
    for (const expected of [
      'GET /central-api/v1/health',
      'GET /central-api/v1/payments/:provider/:paymentId/owner',
      'GET /central-api/v1/payments/:provider/:paymentId/invoice-request',
      'GET /central-api/v1/subscriptions',
      'GET /central-api/v1/users',
      'GET /central-api/v1/users/:ref',
      'GET /central-api/v1/metrics',
      'POST /central-api/v1/users/:ref/plan',
      'POST /central-api/v1/users/:ref/password-reset',
      'POST /central-api/v1/users/:ref/suspend',
      'POST /central-api/v1/users/:ref/unsuspend',
      'POST /central-api/v1/invoices',
      'POST /central-api/v1/payment-events',
    ]) {
      assert.ok(routes.includes(expected), `${expected} in ${routes.join(', ')}`)
    }
    assert.ok(router.has('central_bridge.health'))
  })

  it('does nothing without config', async () => {
    let made = false
    const fakeApp = {
      config: { get: () => undefined },
      container: { make: async () => ((made = true), null) },
    }
    await new CentralBridgeProvider(fakeApp as any).boot()
    assert.equal(made, false)
  })
})
