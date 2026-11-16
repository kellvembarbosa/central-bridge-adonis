import { createServer, type Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppFactory } from '@adonisjs/core/factories/app'
import { ServerFactory } from '@adonisjs/core/factories/http'
import { BodyParserMiddlewareFactory } from '@adonisjs/core/factories/bodyparser'
import { registerCentralBridgeRoutes } from '../src/routes.ts'
import { sign } from '../src/core/signature.ts'
import type { CentralBridgeConfigInput } from '../src/types.ts'

export const TOKEN = 'cbt_test_token_0123456789abcdef'
export const ACTOR = 'ops@central.test'

export interface TestServer {
  baseUrl: string
  close(): Promise<void>
  /** Signed request. `signPath`/`signBody` override what is signed. */
  call(
    method: string,
    path: string,
    options?: {
      body?: string
      headers?: Record<string, string | undefined>
      timestamp?: number | string
      token?: string
      signPath?: string
      signBody?: string
      unsigned?: boolean
    }
  ): Promise<{ status: number; body: any; headers: Headers }>
  /** Signed POST with actor + idempotency key. */
  write(
    path: string,
    body: unknown,
    key?: string,
    headers?: Record<string, string | undefined>
  ): Promise<{ status: number; body: any; headers: Headers }>
}

/**
 * Boots a real AdonisJS HTTP server (router + bodyparser) with the Bridge
 * routes registered, listening on a random port.
 */
export async function startBridgeServer(config: CentralBridgeConfigInput): Promise<TestServer> {
  const app = new AppFactory().create(new URL('../', import.meta.url))
  await app.init()
  const server = new ServerFactory().merge({ app }).create()
  const router = server.getRouter()
  const bodyparser = new BodyParserMiddlewareFactory().create()
  router.use([
    async () => ({
      default: class {
        handle(ctx: any, next: any) {
          return bodyparser.handle(ctx, next)
        }
      },
    }),
  ])

  registerCentralBridgeRoutes(router, { token: TOKEN, product: 'demo', enabled: true, ...config })
  await server.boot()

  const http: NodeServer = createServer(server.handle.bind(server))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`

  const call: TestServer['call'] = async (method, path, options = {}) => {
    const body = options.body ?? ''
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = {}
    if (!options.unsigned) {
      headers['X-Central-Timestamp'] = timestamp
      headers['X-Central-Signature'] = sign(
        options.token ?? TOKEN,
        method,
        options.signPath ?? path,
        timestamp,
        options.signBody ?? body
      )
    }
    if (body) headers['Content-Type'] = 'application/json'
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === undefined) delete headers[name]
      else headers[name] = value
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body || undefined,
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    }
  }

  const write: TestServer['write'] = (path, body, key = crypto.randomUUID(), headers = {}) =>
    call('POST', path, {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'X-Central-Actor': ACTOR, 'X-Idempotency-Key': key, ...headers },
    })

  return {
    baseUrl,
    call,
    write,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
