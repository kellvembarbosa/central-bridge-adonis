import type { HttpContext, Router } from '@adonisjs/core/http'
import { BRIDGE_ROUTES, CentralBridge } from './bridge.ts'
import type {
  BridgeRequest,
  BridgeResponse,
  CentralBridgeConfig,
  CentralBridgeConfigInput,
} from './types.ts'

/**
 * Builds the framework-neutral request from an AdonisJS HttpContext.
 *
 * - `url` is Node's raw `req.url` (exact path + raw query, as signed).
 * - `rawBody` comes from `request.raw()`, filled by the bodyparser for JSON,
 *   form and text bodies. Never re-serialize the parsed body: the signature
 *   covers the exact bytes.
 */
export function toBridgeRequest(ctx: HttpContext): BridgeRequest {
  return {
    method: ctx.request.method(),
    url: ctx.request.request.url ?? ctx.request.url(true),
    rawBody: ctx.request.raw() ?? '',
    ip: ctx.request.ip(),
    header: (name) => ctx.request.header(name) ?? undefined,
    params: (ctx.params ?? {}) as Record<string, string>,
    logger: ctx.logger,
  }
}

export function sendBridgeResponse(ctx: HttpContext, response: BridgeResponse) {
  ctx.response.status(response.status)
  ctx.response.header('Cache-Control', 'no-store')
  const requestId = ctx.request.header('x-central-request-id')
  if (requestId) ctx.response.header('X-Central-Request-Id', requestId)
  for (const [name, value] of Object.entries(response.headers)) {
    ctx.response.header(name, value)
  }
  ctx.response.json(response.body)
}

/**
 * Registers every Bridge route under `config.prefix` (default
 * `/central-api/v1`), guarded by the signature middleware. Unknown paths under
 * the prefix answer 404 `not_found` in the contract envelope.
 *
 * Do not call it when the provider (`@central/bridge-adonis/provider`) is
 * registered: the provider already does it.
 */
export function registerCentralBridgeRoutes(
  router: Router,
  config: CentralBridgeConfig | CentralBridgeConfigInput
): CentralBridge {
  const bridge = new CentralBridge(config)

  router
    .group(() => {
      for (const route of BRIDGE_ROUTES) {
        const handler = async (ctx: HttpContext) =>
          sendBridgeResponse(ctx, await bridge.execute(route.name, toBridgeRequest(ctx)))
        const registered =
          route.method === 'GET'
            ? router.get(route.pattern, handler)
            : router.post(route.pattern, handler)
        registered.as(route.name)
      }
      router
        .any('*', (ctx: HttpContext) => sendBridgeResponse(ctx, bridge.notFound()))
        .as('fallback')
    })
    .prefix(bridge.config.prefix)
    .as('central_bridge')
    .use(async (ctx, next) => {
      const denied = bridge.authenticate(toBridgeRequest(ctx))
      if (denied) return sendBridgeResponse(ctx, denied)
      return next()
    })

  return bridge
}
