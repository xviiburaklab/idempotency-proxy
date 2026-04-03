import { request as undiciRequest } from 'undici'
import { cfg } from '../config'
import type { StoredResponse } from '../types'

export interface ForwardResult {
  statusCode: number
  body: unknown
}

export async function forwardRequest(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): Promise<ForwardResult> {
  const url = `${cfg.upstreamUrl}${path}`

  // drop hop-by-hop headers + idempotency-key before forwarding
  const forwardHeaders: Record<string, string> = {}
  const skipHeaders = new Set([
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authorization',
    'idempotency-key',
  ])

  for (const [k, v] of Object.entries(headers)) {
    if (!skipHeaders.has(k.toLowerCase()) && typeof v === 'string') {
      forwardHeaders[k] = v
    }
  }

  const hasBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD'
  const bodyStr = hasBody ? JSON.stringify(body) : undefined

  if (hasBody) {
    forwardHeaders['content-type'] = forwardHeaders['content-type'] ?? 'application/json'
    forwardHeaders['content-length'] = String(Buffer.byteLength(bodyStr!))
  }

  const resp = await undiciRequest(url, {
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    headers: forwardHeaders,
    body: bodyStr,
  })

  // consume body regardless so the connection is freed
  const rawBody = await resp.body.text()

  let parsed: unknown
  const ct = resp.headers['content-type'] ?? ''
  if (typeof ct === 'string' && ct.includes('application/json')) {
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      parsed = rawBody
    }
  } else {
    parsed = rawBody
  }

  return { statusCode: resp.statusCode, body: parsed }
}
