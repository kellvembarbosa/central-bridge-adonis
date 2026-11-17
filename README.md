# @central/bridge-adonis

Bridge da Central para apps **AdonisJS 7**: a API de administração assinada
(HMAC) que cada produto expõe em `/central-api/v1` para a Central consultar e
agir, mais o **cliente da API da Central** (faturação e checkout, produto → Central).

Implementa o contrato `docs/central/bridge-contract.md` (v1). O pacote gêmeo
para Laravel (`applu/central-bridge`, [kellvembarbosa/central-bridge-laravel](https://github.com/kellvembarbosa/central-bridge-laravel))
segue o mesmo contrato e os dois passam nos mesmos vetores de `test-vectors/`.

- Assinatura HMAC-SHA256 sobre o **corpo cru** e o **caminho + query crus**, tolerância de 300 s.
- Lista de IPs permitidos, `X-Central-Actor` e `X-Idempotency-Key` em toda escrita (replay, 409).
- Sanitizador: nenhuma resposta 2xx leva senha, hash, token, documento etc. (só `taker.document` em `invoice-request`).
- Handlers opcionais: o que não existe responde `501 capability_unsupported` e não aparece no `/health`.
- Erros sempre em `{"error": {"code", "message"}}`, mensagens em pt-BR.

## Instalação

O pacote é público no GitHub ([kellvembarbosa/central-bridge-adonis](https://github.com/kellvembarbosa/central-bridge-adonis))
e é instalado direto do repositório, por tag:

```bash
npm install github:kellvembarbosa/central-bridge-adonis#v1.1.0
node ace configure @central/bridge-adonis
```

O script `prepare` compila o pacote (`build/`) durante a instalação.

### O que o `configure` faz

1. Cria `config/central_bridge.ts`.
2. Cria `app/services/central_bridge_handlers.ts` (handlers vazios, com exemplo).
3. Adiciona as variáveis ao `.env` e as validações em `start/env.ts`.
4. Registra o provider `@central/bridge-adonis/provider` no `adonisrc.ts` (ele registra as rotas).

## Variáveis de ambiente

| Variável                     | Significado                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `CENTRAL_BRIDGE_ENABLED`     | `true` liga as rotas. Desligada, toda rota responde 404 `not_found`.   |
| `CENTRAL_BRIDGE_TOKEN`       | Token do produto, gerado na Central (tela do produto → "Gerar token"). |
| `CENTRAL_BRIDGE_PRODUCT`     | Slug do produto na Central (o `/health` devolve este valor).           |
| `CENTRAL_BRIDGE_ALLOWED_IPS` | IPs da Central separados por vírgula. Vazio = qualquer IP.             |
| `CENTRAL_URL`                | URL base da Central (só para o cliente de faturação).                  |

## Ajustes obrigatórios no app

**CSRF.** As rotas da Bridge recebem `POST` de servidor para servidor. Libere o
prefixo em `config/shield.ts`:

```ts
csrf: {
  enabled: true,
  exceptRoutes: (ctx) => ctx.request.url().startsWith('/central-api/'),
  // ...
}
```

**Bodyparser.** Mantenha `@adonisjs/core/bodyparser_middleware` no `router.use`
(padrão do starter). A assinatura é conferida com `request.raw()`, que o
bodyparser preenche para JSON; o pacote nunca re-serializa o corpo.

**IP atrás de proxy.** Para `CENTRAL_BRIDGE_ALLOWED_IPS` funcionar atrás de
load balancer, configure `http.trustProxy` em `config/app.ts`; o pacote usa
`request.ip()`.

## Configuração manual (sem `node ace configure`)

`config/central_bridge.ts`:

```ts
import env from '#start/env'
import { defineConfig, stores } from '@central/bridge-adonis'

export default defineConfig({
  enabled: env.get('CENTRAL_BRIDGE_ENABLED', false),
  token: env.get('CENTRAL_BRIDGE_TOKEN', ''),
  product: env.get('CENTRAL_BRIDGE_PRODUCT', ''),
  allowedIps: env.get('CENTRAL_BRIDGE_ALLOWED_IPS', ''),
  idempotencyStore: stores.memory(),
  handlers: () => import('#services/central_bridge_handlers'),
  // opcionais: version, prefix ('/central-api/v1'), maxSkewSeconds (300),
  // idempotencyTtlHours (24), perPage (25)
})
```

Depois, **uma** das duas opções:

- registre o provider no `adonisrc.ts`: `providers: [..., () => import('@central/bridge-adonis/provider')]`;
- ou registre as rotas à mão em `start/routes.ts`:

  ```ts
  import router from '@adonisjs/core/services/router'
  import { registerCentralBridgeRoutes } from '@central/bridge-adonis'
  import centralBridgeConfig from '#config/central_bridge'

  registerCentralBridgeRoutes(router, centralBridgeConfig)
  ```

Não use os dois juntos (as rotas seriam registradas duas vezes).

Validações em `start/env.ts`:

```ts
CENTRAL_BRIDGE_ENABLED: Env.schema.boolean.optional(),
CENTRAL_BRIDGE_TOKEN: Env.schema.string.optional(),
CENTRAL_BRIDGE_PRODUCT: Env.schema.string.optional(),
CENTRAL_BRIDGE_ALLOWED_IPS: Env.schema.string.optional(),
CENTRAL_URL: Env.schema.string.optional(),
```

## Implementando os handlers

`handlers` é um objeto de funções assíncronas, todas opcionais. Use a forma
preguiçosa (`() => import(...)`) no arquivo de config para que models só sejam
carregados depois do boot.

| Capacidade (`/health`) | Handler                                                                       | Rota                                                             |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `payment_owner`        | `paymentOwner(provider, paymentId)`                                           | `GET payments/{provider}/{id}/owner`                             |
| `subscriptions`        | `subscriptions(status, page, perPage)`                                        | `GET subscriptions?status=&page=`                                |
| `users_search`         | `searchUsers(q, page, perPage)`                                               | `GET users?q=&page=`                                             |
| `user_detail`          | `findUser(ref)`                                                               | `GET users/{ref}`                                                |
| `change_plan`          | `changePlan(ref, {plan, until, reason}, actor)`                               | `POST users/{ref}/plan`                                          |
| `password_reset`       | `sendPasswordReset(ref, actor)`                                               | `POST users/{ref}/password-reset`                                |
| `suspend`              | `suspend(ref, reason, actor)` **e** `unsuspend(ref, reason, actor)`           | `POST users/{ref}/suspend` / `unsuspend`                         |
| `metrics`              | `metrics(from, to)`                                                           | `GET metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`                      |
| `invoices`             | `invoiceRequest(provider, paymentId)` **e** `receiveInvoice(delivery, actor)` | `GET payments/{provider}/{id}/invoice-request` / `POST invoices` |
| `payment_events`       | `paymentEvent(event, actor)` (checkout, ver abaixo)                           | `POST payment-events`                                            |

- Os tipos usam camelCase (`userRef`, `hasMore`, `currentPeriodEnd`...); o
  pacote converte para snake_case no fio e converte o corpo recebido
  (`invoice_id` → `invoiceId`). Chaves livres (`limits`, `usage`, `metrics`)
  passam como estão.
- Datas aceitam `string` ISO, `Date` ou `DateTime` do Luxon.
- Páginas: devolva `{ data, hasMore }`; o pacote acrescenta `page` e `per_page` (25).
- `actor` é o e-mail de quem pediu na Central (`X-Central-Actor`). Registre-o na sua auditoria.
- Usuário inexistente: lance `UserNotFoundError` (ou devolva `null` em `findUser`) → 404 `not_found`.
- Outra recusa de regra de negócio: `throw new BridgeError('validation_failed', 'Plano inexistente.')`.
- Qualquer outra exceção vira 500 `internal_error` sem detalhe na resposta (o erro vai para o `logger` do app).
- `receiveInvoice` precisa ser idempotente por `delivery.invoiceId`.
- `paymentEvent` precisa ser idempotente por `event.id` (e conceder no máximo uma vez por `event.payment.id`).

```ts
// app/services/central_bridge_handlers.ts
import { UserNotFoundError, type BridgeHandlers } from '@central/bridge-adonis'
import User from '#models/user'

const handlers: BridgeHandlers = {
  async searchUsers(q, page, perPage) {
    const rows = await User.query()
      .if(q, (query) =>
        query.where((w) => w.whereILike('email', `%${q}%`).orWhereILike('full_name', `%${q}%`))
      )
      .orderBy('id', 'desc')
      .offset((page - 1) * perPage)
      .limit(perPage + 1)

    return {
      data: rows.slice(0, perPage).map((user) => ({
        ref: String(user.id),
        email: user.email,
        name: user.fullName,
        plan: user.plan,
        suspended: user.suspendedAt !== null,
        createdAt: user.createdAt,
        lastSeenAt: user.lastSeenAt,
      })),
      hasMore: rows.length > perPage,
    }
  },

  async findUser(ref) {
    const user = await User.find(ref)
    if (!user) return null
    return {
      ref: String(user.id),
      email: user.email,
      name: user.fullName,
      plan: user.plan,
      suspended: user.suspendedAt !== null,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      limits: { projects: 10 },
      usage: { projects: 3 },
      subscriptions: [],
      recentEvents: [],
    }
  },

  async suspend(ref, reason, actor) {
    const user = await User.find(ref)
    if (!user) throw new UserNotFoundError()
    // ... suspender e auditar (reason, actor)
  },

  async unsuspend(ref, reason, actor) {
    // ...
  },
}

export default handlers
```

## Idempotência e várias instâncias

Toda `POST` exige `X-Idempotency-Key`. A resposta (status < 500) fica guardada
por 24 h: repetir a mesma chave e o mesmo corpo devolve a resposta guardada com
`X-Idempotency-Replayed: true`; corpo diferente → 409; chave ainda em execução → 409.

O store padrão (`stores.memory()`) vive no processo e **só serve para uma
instância**. Com mais de uma instância (PM2 cluster, várias réplicas,
autoscaling), **use Redis**:

```ts
// requer @adonisjs/redis configurado
idempotencyStore: stores.redis(),            // conexão padrão
idempotencyStore: stores.redis('main', { prefix: 'bridge:' }),
idempotencyStore: stores.redisClient(ioredisClient), // cliente ioredis próprio
```

Também é possível passar qualquer objeto que implemente `IdempotencyStore`
(`get`, `set`, `lock`).

## Cliente da API de faturação (§9)

Assina com o mesmo token e esquema, mais `X-Central-Product`. Usa o `fetch`
global.

```ts
import env from '#start/env'
import { CentralClient, CentralApiError } from '@central/bridge-adonis'

const central = new CentralClient({
  baseUrl: env.get('CENTRAL_URL')!,
  token: env.get('CENTRAL_BRIDGE_TOKEN')!,
  product: env.get('CENTRAL_BRIDGE_PRODUCT')!,
})

try {
  const invoice = await central.issueInvoice(
    {
      taker: { document: '12345678000195', name: 'ACME Ltda', email: 'financeiro@acme.com' },
      amountCents: 4990,
      description: 'Assinatura Pro — novembro/2026',
      reference: payment.id,
    },
    `invoice-${payment.id}` // X-Idempotency-Key
  )

  await central.listInvoices(2)
  await central.getInvoice(invoiceId)
  const pdf = await central.invoicePdf(invoiceId) // Buffer
  const xml = await central.invoiceXml(invoiceId) // string
  await central.cancelInvoice(invoiceId, 'Emitida com valor incorreto', `cancel-${invoiceId}`)
} catch (error) {
  if (error instanceof CentralApiError) {
    // error.code, error.message (pt-BR), error.status (0 = falha de rede)
  }
}
```

As respostas JSON da faturação são devolvidas como chegaram (formato documentado
em `/api/docs` da Central).

## Checkout pela Central (§10)

A Central é dona do checkout e dos pagamentos: planos, preços e chaves de
gateway ficam lá (painel → produto → **Checkout e planos**). O produto **não
guarda chave de gateway**; só escolhe o slug do plano e reage às notificações
assinadas da Central. Mesmo `CentralClient` da seção anterior:

```ts
// 1. Página de preços: planos à venda, já ordenados.
const plans = await central.listPlans() // GET /api/v1/plans
// [{ slug, name, description, interval: 'day'|'week'|'month'|'year'|'lifetime',
//    intervalCount, recurring, amountCents, originalAmountCents, currency, badge,
//    features, sortOrder }]

// 2. Checkout: a Central cria a cobrança (Pix na Woovi, cartão/boleto no Asaas…).
const payment = await central.createPayment(
  {
    plan: 'vitalicio',
    customer: { name, email, document }, // document opcional (alguns gateways exigem)
    productUserRef: String(user.id),
    method: 'pix', // ou 'card' | 'boleto' | null (padrão do gateway / página hospedada)
    tracking: { utm_source },
  },
  `checkout:${user.id}:${attemptId}` // X-Idempotency-Key: chave nova a cada tentativa
) // POST /api/v1/payments
// payment.pix?.copyPaste / payment.pix?.qrCodeImageUrl / payment.checkoutUrl

// 3. Página de retorno/polling: pagamentos pendentes são reconsultados no gateway.
const current = await central.getPayment(payment.id) // GET /api/v1/payments/{id}
// status: pending | paid | expired | refunded | failed
```

Os três métodos devolvem objetos em camelCase (`Plan`, `PaymentRecord`); erros
da Central (ex.: `plan_unavailable`) chegam como `CentralApiError`.

Depois implemente o handler `paymentEvent`: a Central chama
`POST /central-api/v1/payment-events` (assinado, com `X-Central-Actor` e
`X-Idempotency-Key`, e reenviado até receber 2xx):

```ts
// app/services/central_bridge_handlers.ts
const handlers: BridgeHandlers = {
  async paymentEvent(event) {
    switch (event.type) {
      case 'payment.paid': // concede event.payment.plan a event.payment.productUserRef
        return grantOnce(event.payment.id, event.payment)
      case 'payment.refunded': // estorno total ou chargeback: revoga
        return revoke(event.payment.id)
      case 'subscription.renewed': // estende até event.subscription.currentPeriodEnd
        return extend(event.payment.id, event.subscription!.currentPeriodEnd)
      case 'subscription.ended': // cancelada/expirada: não renova mais
      case 'payment.expired':
        return markEnded(event.payment.id, event.type)
    }
  },
}
```

Trate **de forma idempotente por `event.id`** e conceda no máximo uma vez por
`payment.id`: a mesma notificação pode chegar mais de uma vez, e o produto pode
ver `status: 'paid'` pelo `getPayment` antes. Lançar exceção faz a Central
tentar de novo depois. Com mais de uma instância, use o `idempotencyStore`
compartilhado (`stores.redis()`).

## Uso fora do AdonisJS / núcleo puro

`@central/bridge-adonis/core` exporta `sign`, `verifySignature`, `sanitize`,
os erros do contrato e o `MemoryIdempotencyStore`, sem dependência de framework.
`CentralBridge` (exportado na raiz) recebe uma requisição neutra e devolve
`{status, body, headers}` via `dispatch(route, request)`.

## Desenvolvimento

```bash
npm test          # node:test (Node >= 22.18 roda TypeScript direto)
npm run typecheck
npm run build     # compila para build/ e copia os stubs
```

Os testes carregam os vetores compartilhados em `test-vectors/` e
sobem um servidor AdonisJS real (router + bodyparser) para os testes HTTP.

## Licença

MIT. Veja `LICENSE`.
