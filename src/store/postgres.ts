import { Pool } from 'pg'
import { cfg } from '../config'
import type { IdempotencyRecord, StoredResponse } from '../types'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: cfg.databaseUrl })
    pool.on('error', (err) => {
      console.error('[pg] pool error:', err.message)
    })
  }
  return pool
}

export async function findRecord(key: string): Promise<IdempotencyRecord | null> {
  const result = await getPool().query<{
    id: string
    key: string
    request_hash: string
    status_code: number
    response_body: unknown
    created_at: Date
    expires_at: Date
  }>(
    `SELECT id, key, request_hash, status_code, response_body, created_at, expires_at
     FROM idempotency_records
     WHERE key = $1 AND expires_at > NOW()`,
    [key],
  )

  if (result.rowCount === 0) return null

  const row = result.rows[0]
  return {
    id: row.id,
    key: row.key,
    requestHash: row.request_hash,
    statusCode: row.status_code,
    responseBody: row.response_body,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export async function saveRecord(
  key: string,
  requestHash: string,
  response: StoredResponse,
): Promise<void> {
  const expiresAt = new Date(Date.now() + cfg.ttlSeconds * 1000)

  await getPool().query(
    `INSERT INTO idempotency_records (key, request_hash, status_code, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO NOTHING`,
    [key, requestHash, response.statusCode, JSON.stringify(response.body), expiresAt],
  )
}

export async function deleteRecord(key: string): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM idempotency_records WHERE key = $1',
    [key],
  )
  return (result.rowCount ?? 0) > 0
}

export async function getStats(): Promise<{ total: number; expired: number }> {
  const result = await getPool().query<{ total: string; expired: string }>(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired
    FROM idempotency_records
  `)
  return {
    total: parseInt(result.rows[0].total, 10),
    expired: parseInt(result.rows[0].expired, 10),
  }
}

export async function deleteExpired(): Promise<number> {
  const result = await getPool().query(
    'DELETE FROM idempotency_records WHERE expires_at <= NOW()',
  )
  return result.rowCount ?? 0
}

export async function listRecent(limit = 50): Promise<IdempotencyRecord[]> {
  const result = await getPool().query<{
    id: string
    key: string
    request_hash: string
    status_code: number
    response_body: unknown
    created_at: Date
    expires_at: Date
  }>(
    `SELECT id, key, request_hash, status_code, response_body, created_at, expires_at
     FROM idempotency_records
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  )

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    requestHash: row.request_hash,
    statusCode: row.status_code,
    responseBody: row.response_body,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }))
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
