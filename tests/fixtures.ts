import { BridgeError, UserNotFoundError } from '../src/core/errors.ts'
import type {
  BridgeHandlers,
  InvoiceDelivery,
  PlanChange,
  SubscriptionRecord,
} from '../src/types.ts'

export interface Calls {
  [name: string]: unknown[][]
}

export const subscription: SubscriptionRecord = {
  ref: 's_1',
  userRef: 'u_42',
  provider: 'stripe',
  providerSubscriptionId: 'sub_123',
  status: 'active',
  plan: 'pro',
  amountCents: 4990,
  currency: 'BRL',
  interval: 'month',
  currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
}

/** Full set of fake handlers recording their calls. */
export function fakeHandlers(calls: Calls = {}): BridgeHandlers {
  const record = (name: string, args: unknown[]) => {
    calls[name] ??= []
    calls[name].push(args)
  }

  return {
    async paymentOwner(provider, paymentId) {
      record('paymentOwner', [provider, paymentId])
      return { owned: true, userRef: 'u_42', kind: 'subscription', localStatus: 'paid' }
    },
    async invoiceRequest(provider, paymentId) {
      record('invoiceRequest', [provider, paymentId])
      return {
        requested: true,
        requestRef: 'req_1',
        email: 'ana@x.com',
        serviceDescription: 'Assinatura Pro',
        taker: { document: '12345678000195', name: 'ACME' },
      }
    },
    async subscriptions(status, page, perPage) {
      record('subscriptions', [status, page, perPage])
      return { data: [subscription], hasMore: true }
    },
    async searchUsers(query, page, perPage) {
      record('searchUsers', [query, page, perPage])
      return {
        data: [
          {
            ref: 'u_42',
            email: 'ana@x.com',
            name: 'Ana',
            plan: 'pro',
            suspended: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: null,
          },
        ],
        hasMore: false,
      }
    },
    async findUser(ref) {
      record('findUser', [ref])
      if (ref === 'missing') return null
      return {
        ref,
        email: 'ana@x.com',
        name: 'Ana',
        plan: 'pro',
        suspended: false,
        createdAt: { toISO: () => '2026-01-01T00:00:00.000-03:00' },
        lastSeenAt: new Date('2026-11-14T10:00:00Z'),
        limits: { projects: 10, storage: '5GB', seats: null, api_token: 'leak' } as any,
        usage: { projects: 3, documents_issued: 7 },
        subscriptions: [subscription],
        recentEvents: [{ type: 'login', at: '2026-11-14T10:00:00Z', description: null }],
        // extra field a careless handler could leak
        ...({ password: 'hash', rememberToken: 'x' } as object),
      }
    },
    async metrics(from, to) {
      record('metrics', [from, to])
      return [{ date: from, metrics: { new_users: 3, revenueCents: 1000 } }]
    },
    async changePlan(ref: string, change: PlanChange, actor: string) {
      record('changePlan', [ref, change, actor])
      if (ref === 'missing') throw new UserNotFoundError()
      if (change.plan === 'unknown')
        throw new BridgeError('validation_failed', 'Plano inexistente.')
    },
    async sendPasswordReset(ref, actor) {
      record('sendPasswordReset', [ref, actor])
    },
    async suspend(ref, reason, actor) {
      record('suspend', [ref, reason, actor])
    },
    async unsuspend(ref, reason, actor) {
      record('unsuspend', [ref, reason, actor])
    },
    async receiveInvoice(delivery: InvoiceDelivery, actor: string) {
      record('receiveInvoice', [delivery, actor])
    },
  }
}
