import { MemoryIdempotencyStore, type IdempotencyStore } from './core/idempotency.ts'
import { DEFAULT_MAX_SKEW_SECONDS } from './core/signature.ts'
import { RedisIdempotencyStore, type RedisLike } from './redis_store.ts'
import type { CentralBridgeConfig, CentralBridgeConfigInput } from './types.ts'
import {
  BRIDGE_VERSION,
  DEFAULT_IDEMPOTENCY_TTL_HOURS,
  DEFAULT_PER_PAGE,
  DEFAULT_PREFIX,
} from './version.ts'

function parseIps(value: string[] | string | null | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? '').split(',')
  return list.map((ip) => ip.trim()).filter(Boolean)
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '')
  return `/${trimmed}`
}

/**
 * Normalizes the Bridge configuration, filling contract defaults.
 */
export function defineConfig(input: CentralBridgeConfigInput = {}): CentralBridgeConfig {
  return {
    enabled: input.enabled === true,
    token: (input.token ?? '').trim(),
    product: (input.product ?? '').trim(),
    version: input.version ?? BRIDGE_VERSION,
    prefix: normalizePrefix(input.prefix ?? DEFAULT_PREFIX),
    maxSkewSeconds: input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS,
    allowedIps: parseIps(input.allowedIps),
    idempotencyTtlHours: input.idempotencyTtlHours ?? DEFAULT_IDEMPOTENCY_TTL_HOURS,
    perPage: input.perPage ?? DEFAULT_PER_PAGE,
    handlers: input.handlers ?? {},
    idempotencyStore: input.idempotencyStore ?? new MemoryIdempotencyStore(),
  }
}

/**
 * Idempotency store factories for the config file.
 */
export const stores = {
  /** Process-local. Only for a single instance. */
  memory(): IdempotencyStore {
    return new MemoryIdempotencyStore()
  },

  /**
   * Redis via `@adonisjs/redis` (resolved lazily, after the app boots).
   * Required for multi-instance deployments.
   */
  redis(connection?: string, options: { prefix?: string } = {}) {
    return async (): Promise<IdempotencyStore> => {
      const specifier = '@adonisjs/redis/services/main'
      const { default: redis } = (await import(specifier)) as {
        default: { connection(name?: string): RedisLike }
      }
      return new RedisIdempotencyStore(redis.connection(connection), options)
    }
  },

  /** Any ioredis-compatible client you already have. */
  redisClient(client: RedisLike, options: { prefix?: string } = {}): IdempotencyStore {
    return new RedisIdempotencyStore(client, options)
  },
}
