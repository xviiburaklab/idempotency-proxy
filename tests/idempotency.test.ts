import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { idempotencyHandler } from '../src/proxy/middleware'
import * as redis from '../src/store/redis'
import * as postgres from '../src/store/postgres'

// we mock the stores so tests don't need real infra
vi.mock('../src/store/redis')
vi.mock('../src/store/postgres')
vi.mock('../src/proxy/forwarder')

const { forwardRequest } = await import('../src/proxy/forwarder')

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false })
  app.all('/*', idempotencyHandler)
  return app
}

describe('idempotency middleware', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/payments',
      payload: { amount: 100 },
    })

    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/Idempotency-Key/)
  })

  it('returns cached response on second request with same key', async () => {
    const key = 'test-key-cache-hit'

    vi.mocked(postgres.findRecord)
      .mockResolvedValueOnce(null) // first call: miss
      .mockResolvedValueOnce({    // second call: hit
        id: 'some-uuid',
        key,
        requestHash: 'abc123',
        statusCode: 201,
        responseBody: { id: 'order_1', status: 'created' },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
      })

    vi.mocked(redis.acquireLock).mockResolvedValue(true)
    vi.mocked(redis.markDone).mockResolvedValue()
    vi.mocked(forwardRequest).mockResolvedValue({
      statusCode: 201,
      body: { id: 'order_1', status: 'created' },
    })
    vi.mocked(postgres.saveRecord).mockResolvedValue()

    // first request — goes to upstream
    const first = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': key },
      payload: { item: 'laptop' },
    })
    expect(first.statusCode).toBe(201)
    expect(first.headers['x-idempotency-cache']).toBe('MISS')

    // second request with same key — should come from cache
    const second = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': key },
      payload: { item: 'laptop' },
    })
    expect(second.statusCode).toBe(201)
    expect(second.headers['x-idempotency-cache']).toBe('HIT')
    expect(second.json()).toEqual({ id: 'order_1', status: 'created' })

    // upstream should only have been called once
    expect(forwardRequest).toHaveBeenCalledTimes(1)
  })

  it('returns 422 when same key is reused with a different body', async () => {
    const key = 'test-key-hash-mismatch'

    // simulate existing record whose hash won't match the new body
    vi.mocked(postgres.findRecord).mockResolvedValue({
      id: 'some-uuid',
      key,
      requestHash: 'completely-different-hash',
      statusCode: 201,
      responseBody: { id: 'order_1' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400_000),
    })

    const resp = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': key },
      payload: { item: 'something-else' },
    })

    expect(resp.statusCode).toBe(422)
  })

  it('returns 409 when a duplicate request arrives while one is in-flight', async () => {
    const key = 'test-key-in-flight'

    vi.mocked(postgres.findRecord).mockResolvedValue(null)
    vi.mocked(redis.acquireLock).mockResolvedValue(false)
    vi.mocked(redis.getLockStatus).mockResolvedValue('processing')

    const resp = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { 'idempotency-key': key },
      payload: { amount: 50 },
    })

    expect(resp.statusCode).toBe(409)
  })

  it('does not cache a failed upstream response', async () => {
    const key = 'test-key-upstream-fail'

    vi.mocked(postgres.findRecord).mockResolvedValue(null)
    vi.mocked(redis.acquireLock).mockResolvedValue(true)
    vi.mocked(redis.releaseLock).mockResolvedValue()
    vi.mocked(forwardRequest).mockResolvedValue({ statusCode: 500, body: { error: 'oops' } })

    const resp = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { 'idempotency-key': key },
      payload: { amount: 50 },
    })

    expect(resp.statusCode).toBe(500)
    expect(postgres.saveRecord).not.toHaveBeenCalledWith(key, expect.anything(), expect.anything())
  })
})
