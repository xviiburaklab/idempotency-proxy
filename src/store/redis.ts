import Redis from 'ioredis'
import { cfg } from '../config'
import type { LockStatus } from '../types'

let client: Redis | null = null

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(cfg.redisUrl, {
      lazyConnect: true,
      enableReadyCheck: true,
    })

    client.on('error', (err) => {
      // don't crash on transient redis errors, just log
      console.error('[redis] connection error:', err.message)
    })
  }
  return client
}

export async function acquireLock(key: string): Promise<boolean> {
  const redis = getRedis()
  const result = await redis.set(
    `idem:lock:${key}`,
    'processing' satisfies LockStatus,
    'EX',
    cfg.lockTtlSeconds,
    'NX',
  )
  return result === 'OK'
}

export async function releaseLock(key: string): Promise<void> {
  const redis = getRedis()
  await redis.del(`idem:lock:${key}`)
}

export async function markDone(key: string): Promise<void> {
  const redis = getRedis()
  // overwrite the lock with "done" so we know it completed (short TTL is fine)
  // short ttl is fine here, postgres is the source of truth
  await redis.set(`idem:lock:${key}`, 'done' satisfies LockStatus, 'EX', 60)
}

export async function getLockStatus(key: string): Promise<LockStatus | null> {
  const redis = getRedis()
  const val = await redis.get(`idem:lock:${key}`)
  if (val === 'processing' || val === 'done') return val
  return null
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
