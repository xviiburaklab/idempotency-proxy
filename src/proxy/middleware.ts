import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { acquireLock, getLockStatus, markDone, releaseLock } from '../store/redis'
import { findRecord, saveRecord } from '../store/postgres'
import { forwardRequest } from './forwarder'

function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}:${path}:${JSON.stringify(body ?? '')}`)
    .digest('hex')
}

export async function idempotencyHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idempotencyKey = req.headers['idempotency-key']

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return reply.status(400).send({
      error: 'Missing Idempotency-Key header',
    })
  }

  const method = req.method
  const path = req.url
  const body = req.body

  // already processed this one?
  const existing = await findRecord(idempotencyKey)

  if (existing) {
    const incomingHash = hashRequest(method, path, body)

    if (incomingHash !== existing.requestHash) {
      // same key, different request — this is a client bug
      return reply.status(422).send({
        error: 'Idempotency-Key reuse with different request body',
      })
    }

    reply.header('X-Idempotency-Cache', 'HIT')
    return reply.status(existing.statusCode).send(existing.responseBody)
  }

  const acquired = await acquireLock(idempotencyKey)

  if (!acquired) {
    // someone else is currently processing this exact key
    const status = await getLockStatus(idempotencyKey)

    if (status === 'processing') {
      return reply.status(409).send({
        error: 'A request with this Idempotency-Key is already being processed',
      })
    }

    // lock expired and postgres doesn't have it either — treat as new request
    // (upstream probably crashed mid-flight)
  }

  let result: Awaited<ReturnType<typeof forwardRequest>>

  try {
    result = await forwardRequest(
      method,
      path,
      req.headers as Record<string, string | string[] | undefined>,
      body,
    )
  } catch (err) {
    await releaseLock(idempotencyKey)
    req.log.error({ err }, 'upstream request failed')
    return reply.status(502).send({ error: 'Upstream request failed' })
  }

  // only cache successful responses
  if (result.statusCode >= 200 && result.statusCode < 300) {
    const hash = hashRequest(method, path, body)
    await saveRecord(idempotencyKey, hash, {
      statusCode: result.statusCode,
      body: result.body,
    })
    await markDone(idempotencyKey)
  } else {
    // upstream returned an error — don't cache, release lock so client can retry
    await releaseLock(idempotencyKey)
  }

  reply.header('X-Idempotency-Cache', 'MISS')
  return reply.status(result.statusCode).send(result.body)
}
