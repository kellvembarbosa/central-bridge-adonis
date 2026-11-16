import { sha256Hex } from './signature.ts'

/**
 * Idempotency storage for Bridge writes (§3). Framework-free.
 */

export interface IdempotencyRecord {
  fingerprint: string
  status: number
  body: unknown
}

/** Releases a lock acquired with `IdempotencyStore.lock`. */
export type IdempotencyLockRelease = () => Promise<void>

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>
  /**
   * Tries to acquire an exclusive lock for `key`. Returns a release function
   * when acquired, or `null` when another request holds it.
   */
  lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null>
}

/** sha256(METHOD \n path \n rawBody) */
export function idempotencyFingerprint(method: string, path: string, rawBody: string): string {
  return sha256Hex(`${method.toUpperCase()}\n${path}\n${rawBody ?? ''}`)
}

/**
 * Process-local store. Fine for a single instance; multi-instance
 * deployments MUST use a shared store (Redis).
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  #records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>()
  #locks = new Map<string, number>()
  #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const entry = this.#records.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.#now()) {
      this.#records.delete(key)
      return null
    }
    return structuredClone(entry.record)
  }

  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    this.#sweep()
    this.#records.set(key, {
      record: structuredClone(record),
      expiresAt: this.#now() + ttlSeconds * 1000,
    })
  }

  async lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null> {
    const now = this.#now()
    const heldUntil = this.#locks.get(key)
    if (heldUntil !== undefined && heldUntil > now) return null

    const expiresAt = now + ttlSeconds * 1000
    this.#locks.set(key, expiresAt)
    return async () => {
      if (this.#locks.get(key) === expiresAt) this.#locks.delete(key)
    }
  }

  #sweep() {
    if (this.#records.size < 1000) return
    const now = this.#now()
    for (const [key, entry] of this.#records) {
      if (entry.expiresAt <= now) this.#records.delete(key)
    }
  }
}
