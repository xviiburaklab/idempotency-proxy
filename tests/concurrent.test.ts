import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { idempotencyHandler } from '../src/proxy/middleware'
import * as redis from '../src/store/redis'
import * as postgres from '../src/store/postgres'

vi.mock('../src/store/redis')
vi.mock('../src/store/postgres')
vi.mock('../src/proxy/forwarder')

const { forwardRequest } = await import('../src/proxy/forwarder')

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false })
  app.all('/*', idempotencyHandler)
  return app
}

describe('concurrent request handling', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('only forwards one request upstream when 10 concurrent requests share the same key', async () => {
    const key = 'concurrent-test-key'
    let lockAcquired = false

    // only the first caller gets the lock
    vi.mocked(redis.acquireLock).mockImplementation(async () => {
      if (!lockAcquired) {
        lockAcquired = true
        return true
      }
      return false
    })

    vi.mocked(redis.getLockStatus).mockResolvedValue('processing')
    vi.mocked(redis.markDone).mockResolvedValue()
    vi.mocked(postgres.findRecord).mockResolvedValue(null)
    vi.mocked(postgres.saveRecord).mockResolvedValue()
    vi.mocked(forwardRequest).mockResolvedValue({
      statusCode: 200,
      body: { ok: true },
    })

    const requests = Array.from({ length: 10 }, () =>
      app.inject({
        method: 'POST',
        url: '/charge',
        headers: { 'idempotency-key': key },
        payload: { amount: 9900 },
      }),
    )

    const responses = await Promise.all(requests)

    const statuses = responses.map((r) => r.statusCode)
    const upstreamCalls = vi.mocked(forwardRequest).mock.calls.length

    // exactly one request should reach upstream
    expect(upstreamCalls).toBe(1)

    // one 200, rest should be 409
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(9)
  })

  it('treats an expired TTL key as a fresh request', async () => {
    const key = 'expired-key-test'

    // record exists but is expired — findRecord should return null (query filters by expires_at > NOW())
    vi.mocked(postgres.findRecord).mockResolvedValue(null)
    vi.mocked(redis.acquireLock).mockResolvedValue(true)
    vi.mocked(redis.markDone).mockResolvedValue()
    vi.mocked(postgres.saveRecord).mockResolvedValue()
    vi.mocked(forwardRequest).mockResolvedValue({ statusCode: 200, body: { renewed: true } })

    const resp = await app.inject({
      method: 'POST',
      url: '/renew',
      headers: { 'idempotency-key': key },
      payload: { plan: 'pro' },
    })

    expect(resp.statusCode).toBe(200)
    expect(forwardRequest).toHaveBeenCalled()
  })
})
