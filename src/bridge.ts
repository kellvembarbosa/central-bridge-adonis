import {
  BridgeError,
  IDEMPOTENCY_IN_PROGRESS_MESSAGE,
  UserNotFoundError,
  ValidationFailedError,
  errorBody,
  type BridgeErrorCode,
} from './core/errors.ts'
import {
  idempotencyFingerprint,
  type IdempotencyRecord,
  type IdempotencyStore,
} from './core/idempotency.ts'
import { sanitize } from './core/sanitizer.ts'
import { verifySignature } from './core/signature.ts'
import { defineConfig } from './define_config.ts'
import {
  invoiceRequestToWire,
  isValidDate,
  metricsToWire,
  pageToWire,
  parseInvoiceDelivery,
  parseJsonObject,
  parsePlanChange,
  parseReason,
  paymentOwnerToWire,
  subscriptionToWire,
  userDetailToWire,
  userSummaryToWire,
} from './serializers.ts'
import { parsePaymentEvent, parsePaymentNotice } from './checkout.ts'
import {
  SUBSCRIPTION_STATUSES,
  type BridgeHandlers,
  type BridgeRequest,
  type BridgeResponse,
  type Capability,
  type CentralBridgeConfig,
  type CentralBridgeConfigInput,
  type HealthResponse,
  type SubscriptionStatus,
} from './types.ts'

export type BridgeRouteName =
  | 'health'
  | 'paymentOwner'
  | 'invoiceRequest'
  | 'subscriptions'
  | 'searchUsers'
  | 'findUser'
  | 'metrics'
  | 'changePlan'
  | 'sendPasswordReset'
  | 'suspend'
  | 'unsuspend'
  | 'receiveInvoice'
  | 'paymentEvent'
  | 'paymentNotice'

export interface BridgeRouteDefinition {
  name: BridgeRouteName
  method: 'GET' | 'POST'
  /** Relative to the prefix, AdonisJS route syntax. */
  pattern: string
}

/** Routes of the contract (§7), relative to `/central-api/v1`. */
export const BRIDGE_ROUTES: readonly BridgeRouteDefinition[] = [
  { name: 'health', method: 'GET', pattern: 'health' },
  { name: 'paymentOwner', method: 'GET', pattern: 'payments/:provider/:paymentId/owner' },
  {
    name: 'invoiceRequest',
    method: 'GET',
    pattern: 'payments/:provider/:paymentId/invoice-request',
  },
  { name: 'subscriptions', method: 'GET', pattern: 'subscriptions' },
  { name: 'searchUsers', method: 'GET', pattern: 'users' },
  { name: 'findUser', method: 'GET', pattern: 'users/:ref' },
  { name: 'metrics', method: 'GET', pattern: 'metrics' },
  { name: 'changePlan', method: 'POST', pattern: 'users/:ref/plan' },
  { name: 'sendPasswordReset', method: 'POST', pattern: 'users/:ref/password-reset' },
  { name: 'suspend', method: 'POST', pattern: 'users/:ref/suspend' },
  { name: 'unsuspend', method: 'POST', pattern: 'users/:ref/unsuspend' },
  { name: 'receiveInvoice', method: 'POST', pattern: 'invoices' },
  { name: 'paymentEvent', method: 'POST', pattern: 'payment-events' },
  { name: 'paymentNotice', method: 'POST', pattern: 'payment-notices' },
]

const ROUTES_BY_NAME = new Map(BRIDGE_ROUTES.map((route) => [route.name, route]))

/** Exact paths kept by the sanitizer, per route (§5). */
const SANITIZER_ALLOW: Partial<Record<BridgeRouteName, string[]>> = {
  invoiceRequest: ['taker.document'],
}

const LOCK_TTL_SECONDS = 300
const MAX_QUERY_LENGTH = 191
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeIp(ip: string): string {
  const value = ip.trim().toLowerCase()
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value
}

function queryOf(url: string): URLSearchParams {
  const index = url.indexOf('?')
  return new URLSearchParams(index === -1 ? '' : url.slice(index + 1))
}

function pathOf(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

function parsePage(value: string | null): number {
  if (value === null || value === '') return 1
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) {
    throw new ValidationFailedError(
      'Dados inválidos: "page" deve ser um inteiro maior ou igual a 1.'
    )
  }
  return Number(value)
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): BridgeResponse {
  return { status, body, headers }
}

function errorResponse(code: BridgeErrorCode, message?: string): BridgeResponse {
  const error = new BridgeError(code, message)
  return json(error.status, error.toBody())
}

/**
 * Framework-free Bridge engine: authentication, idempotency, dispatching to
 * the product handlers, wire serialization and sanitization.
 */
export class CentralBridge {
  readonly config: CentralBridgeConfig
  #now: () => number
  #handlers?: Promise<BridgeHandlers>
  #store?: Promise<IdempotencyStore>

  constructor(
    config: CentralBridgeConfig | CentralBridgeConfigInput,
    options: { now?: () => number } = {}
  ) {
    this.config = defineConfig(config)
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /**
   * Gate checks in contract order: disabled (404) → IP (403) → signature
   * (401). Returns the error response, or `null` when the request may go on.
   */
  authenticate(request: BridgeRequest): BridgeResponse | null {
    if (!this.config.enabled) return errorResponse('not_found')

    if (this.config.allowedIps.length > 0) {
      const ip = normalizeIp(request.ip ?? '')
      const allowed = this.config.allowedIps.some((candidate) => normalizeIp(candidate) === ip)
      if (!allowed) return errorResponse('ip_not_allowed')
    }

    const verdict = verifySignature({
      token: this.config.token,
      method: request.method,
      pathWithQuery: request.url,
      rawBody: request.rawBody,
      timestamp: request.header('x-central-timestamp'),
      signature: request.header('x-central-signature'),
      now: this.#now(),
      maxSkewSeconds: this.config.maxSkewSeconds,
    })
    return verdict === 'valid' ? null : errorResponse(verdict)
  }

  /**
   * authenticate + execute. Handy outside AdonisJS.
   */
  async dispatch(route: BridgeRouteName, request: BridgeRequest): Promise<BridgeResponse> {
    return this.authenticate(request) ?? this.execute(route, request)
  }

  /**
   * Runs an already authenticated request. Never throws.
   */
  async execute(route: BridgeRouteName, request: BridgeRequest): Promise<BridgeResponse> {
    const definition = ROUTES_BY_NAME.get(route)
    if (!definition) return errorResponse('not_found')

    try {
      if (definition.method === 'POST') {
        return await this.#executeWrite(definition, request)
      }
      return await this.#safeRun(route, request, null)
    } catch (error) {
      return this.#internalError(error, route, request)
    }
  }

  notFound(): BridgeResponse {
    return errorResponse('not_found')
  }

  async capabilities(): Promise<Capability[]> {
    const h = await this.#resolveHandlers()
    const list: Capability[] = []
    if (h.paymentOwner) list.push('payment_owner')
    if (h.subscriptions) list.push('subscriptions')
    if (h.searchUsers) list.push('users_search')
    if (h.findUser) list.push('user_detail')
    if (h.changePlan) list.push('change_plan')
    if (h.sendPasswordReset) list.push('password_reset')
    if (h.suspend && h.unsuspend) list.push('suspend')
    if (h.metrics) list.push('metrics')
    if (h.invoiceRequest && h.receiveInvoice) list.push('invoices')
    if (h.paymentEvent) list.push('payment_events')
    if (h.paymentNotice) list.push('payment_notices')
    return list
  }

  async health(): Promise<HealthResponse> {
    return {
      version: this.config.version,
      product: this.config.product,
      capabilities: await this.capabilities(),
    }
  }

  /* ---------------------------------------------------------------------- */

  async #executeWrite(
    definition: BridgeRouteDefinition,
    request: BridgeRequest
  ): Promise<BridgeResponse> {
    const actor = (request.header('x-central-actor') ?? '').trim()
    if (!actor || actor.length > 254 || !EMAIL_RE.test(actor)) {
      return errorResponse('missing_actor')
    }

    const key = request.header('x-idempotency-key') ?? ''
    if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return errorResponse(
        'validation_failed',
        'Dados inválidos: informe X-Idempotency-Key com 1 a 128 caracteres.'
      )
    }

    const store = await this.#resolveStore()
    const fingerprint = idempotencyFingerprint(
      request.method,
      pathOf(request.url),
      request.rawBody ?? ''
    )

    const existing = await store.get(key)
    if (existing) return this.#replay(existing, fingerprint)

    const release = await store.lock(key, LOCK_TTL_SECONDS)
    if (!release) {
      const finished = await store.get(key)
      if (finished) return this.#replay(finished, fingerprint)
      return errorResponse('idempotency_conflict', IDEMPOTENCY_IN_PROGRESS_MESSAGE)
    }

    try {
      const response = await this.#safeRun(definition.name, request, actor)
      if (response.status < 500) {
        await store.set(
          key,
          { fingerprint, status: response.status, body: response.body },
          this.config.idempotencyTtlHours * 3600
        )
      }
      return response
    } finally {
      await release()
    }
  }

  #replay(record: IdempotencyRecord, fingerprint: string): BridgeResponse {
    if (record.fingerprint !== fingerprint) return errorResponse('idempotency_conflict')
    return json(record.status, record.body, { 'X-Idempotency-Replayed': 'true' })
  }

  async #safeRun(
    route: BridgeRouteName,
    request: BridgeRequest,
    actor: string | null
  ): Promise<BridgeResponse> {
    try {
      const body = await this.#run(route, request, actor ?? '')
      return json(200, sanitize(body, SANITIZER_ALLOW[route] ?? []))
    } catch (error) {
      if (error instanceof BridgeError) return json(error.status, error.toBody())
      return this.#internalError(error, route, request)
    }
  }

  #internalError(error: unknown, route: BridgeRouteName, request: BridgeRequest): BridgeResponse {
    request.logger?.error({ err: error, route }, 'Central Bridge: erro ao processar a requisição')
    return json(500, errorBody('internal_error'))
  }

  async #run(route: BridgeRouteName, request: BridgeRequest, actor: string): Promise<unknown> {
    const h = await this.#resolveHandlers()
    const query = queryOf(request.url)
    const params = request.params
    const perPage = this.config.perPage

    switch (route) {
      case 'health':
        return this.health()

      case 'paymentOwner': {
        if (!h.paymentOwner) throw new BridgeError('capability_unsupported')
        return paymentOwnerToWire(await h.paymentOwner(params.provider, params.paymentId))
      }

      case 'invoiceRequest': {
        if (!h.invoiceRequest) throw new BridgeError('capability_unsupported')
        return invoiceRequestToWire(await h.invoiceRequest(params.provider, params.paymentId))
      }

      case 'subscriptions': {
        if (!h.subscriptions) throw new BridgeError('capability_unsupported')
        const rawStatus = query.get('status') ?? ''
        if (rawStatus && !(SUBSCRIPTION_STATUSES as readonly string[]).includes(rawStatus)) {
          throw new ValidationFailedError(
            `Dados inválidos: "status" deve ser um de ${SUBSCRIPTION_STATUSES.join(', ')}.`
          )
        }
        const status = (rawStatus || null) as SubscriptionStatus | null
        const page = parsePage(query.get('page'))
        const result = await h.subscriptions(status, page, perPage)
        return pageToWire(result, page, perPage, subscriptionToWire)
      }

      case 'searchUsers': {
        if (!h.searchUsers) throw new BridgeError('capability_unsupported')
        const q = query.get('q') ?? ''
        if (q.length > MAX_QUERY_LENGTH) {
          throw new ValidationFailedError(
            `Dados inválidos: "q" aceita no máximo ${MAX_QUERY_LENGTH} caracteres.`
          )
        }
        const page = parsePage(query.get('page'))
        const result = await h.searchUsers(q, page, perPage)
        return pageToWire(result, page, perPage, userSummaryToWire)
      }

      case 'findUser': {
        if (!h.findUser) throw new BridgeError('capability_unsupported')
        const user = await h.findUser(params.ref)
        if (!user) throw new UserNotFoundError()
        return userDetailToWire(user)
      }

      case 'metrics': {
        if (!h.metrics) throw new BridgeError('capability_unsupported')
        const from = query.get('from') ?? ''
        const to = query.get('to') ?? ''
        if (!isValidDate(from) || !isValidDate(to) || from > to) {
          throw new ValidationFailedError(
            'Dados inválidos: informe "from" e "to" no formato YYYY-MM-DD, com from <= to.'
          )
        }
        return metricsToWire(await h.metrics(from, to))
      }

      case 'changePlan': {
        if (!h.changePlan) throw new BridgeError('capability_unsupported')
        await h.changePlan(params.ref, parsePlanChange(request.rawBody), actor)
        return { ok: true }
      }

      case 'sendPasswordReset': {
        if (!h.sendPasswordReset) throw new BridgeError('capability_unsupported')
        await h.sendPasswordReset(params.ref, actor)
        return { ok: true, message: 'E-mail de redefinição enviado.' }
      }

      case 'suspend': {
        if (!h.suspend) throw new BridgeError('capability_unsupported')
        await h.suspend(params.ref, parseReason(request.rawBody), actor)
        return { ok: true }
      }

      case 'unsuspend': {
        if (!h.unsuspend) throw new BridgeError('capability_unsupported')
        await h.unsuspend(params.ref, parseReason(request.rawBody), actor)
        return { ok: true }
      }

      case 'receiveInvoice': {
        if (!h.receiveInvoice) throw new BridgeError('capability_unsupported')
        await h.receiveInvoice(parseInvoiceDelivery(request.rawBody), actor)
        return { ok: true }
      }

      case 'paymentEvent': {
        if (!h.paymentEvent) throw new BridgeError('capability_unsupported')
        await h.paymentEvent(parsePaymentEvent(parseJsonObject(request.rawBody)), actor)
        return { ok: true }
      }

      case 'paymentNotice': {
        if (!h.paymentNotice) throw new BridgeError('capability_unsupported')
        await h.paymentNotice(parsePaymentNotice(parseJsonObject(request.rawBody)), actor)
        return { ok: true }
      }
    }
  }

  #resolveHandlers(): Promise<BridgeHandlers> {
    if (!this.#handlers) {
      const source = this.config.handlers
      this.#handlers = (async () => {
        if (typeof source !== 'function') return source
        const loaded = await source()
        return 'default' in loaded && loaded.default ? loaded.default : (loaded as BridgeHandlers)
      })()
      // Allow a retry if a lazy import fails.
      this.#handlers.catch(() => (this.#handlers = undefined))
    }
    return this.#handlers
  }

  #resolveStore(): Promise<IdempotencyStore> {
    if (!this.#store) {
      const source = this.config.idempotencyStore
      this.#store = Promise.resolve(typeof source === 'function' ? source() : source)
      this.#store.catch(() => (this.#store = undefined))
    }
    return this.#store
  }
}
