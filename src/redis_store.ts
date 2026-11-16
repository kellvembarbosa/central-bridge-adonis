import { randomUUID } from 'node:crypto'
import type {
  IdempotencyLockRelease,
  IdempotencyRecord,
  IdempotencyStore,
} from './core/idempotency.ts'

/**
 * Subset of the ioredis API used by the store. `@adonisjs/redis` connections
 * (and plain ioredis clients) satisfy it.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Shared idempotency store. Required when the product runs more than one
 * instance (otherwise a replay could land on an instance that never saw it).
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  #redis: RedisLike
  #prefix: string

  constructor(redis: RedisLike, options: { prefix?: string } = {}) {
    this.#redis = redis
    this.#prefix = options.prefix ?? 'central_bridge:idempotency:'
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.#redis.get(`${this.#prefix}${key}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as IdempotencyRecord
    } catch {
      return null
    }
  }

  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    await this.#redis.set(
      `${this.#prefix}${key}`,
      JSON.stringify(record),
      'EX',
      Math.max(1, Math.ceil(ttlSeconds))
    )
  }

  async lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null> {
    const lockKey = `${this.#prefix}lock:${key}`
    const owner = randomUUID()
    const acquired = await this.#redis.set(
      lockKey,
      owner,
      'EX',
      Math.max(1, Math.ceil(ttlSeconds)),
      'NX'
    )
    if (acquired !== 'OK') return null

    return async () => {
      if (typeof this.#redis.eval === 'function') {
        await this.#redis.eval(RELEASE_SCRIPT, 1, lockKey, owner)
      } else if ((await this.#redis.get(lockKey)) === owner) {
        await this.#redis.del(lockKey)
      }
    }
  }
}
