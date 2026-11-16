import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configure, stubsRoot } from '../configure.ts'

describe('configure hook', () => {
  it('publishes config + handlers stubs, env vars, validations and provider', async () => {
    const calls: Array<[string, unknown[]]> = []
    const providers: string[] = []
    const codemods = new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === 'then'
            ? undefined
            : async (...args: unknown[]) => {
                calls.push([name, args])
                if (name === 'updateRcFile') {
                  ;(args[0] as (rc: unknown) => void)({
                    addProvider: (p: string) => providers.push(p),
                  })
                }
              },
      }
    )
    const command = { createCodemods: async () => codemods, logger: { info() {} } }
    await configure(command as any)

    const stubs = calls.filter(([n]) => n === 'makeUsingStub').map(([, a]) => a[1])
    assert.deepEqual(stubs, ['config/central_bridge.stub', 'services/central_bridge_handlers.stub'])
    for (const stub of stubs) assert.ok(existsSync(join(stubsRoot, stub as string)), String(stub))

    const env = calls.find(([n]) => n === 'defineEnvVariables')![1][0] as Record<string, string>
    assert.deepEqual(Object.keys(env), [
      'CENTRAL_BRIDGE_ENABLED',
      'CENTRAL_BRIDGE_TOKEN',
      'CENTRAL_BRIDGE_PRODUCT',
      'CENTRAL_BRIDGE_ALLOWED_IPS',
      'CENTRAL_URL',
    ])
    assert.ok(calls.some(([n]) => n === 'defineEnvValidations'))
    assert.deepEqual(providers, ['@central/bridge-adonis/provider'])

    const config = readFileSync(join(stubsRoot, 'config/central_bridge.stub'), 'utf8')
    assert.match(config, /app\.configPath\('central_bridge\.ts'\)/)
    assert.match(config, /CENTRAL_BRIDGE_ALLOWED_IPS/)
  })
})
