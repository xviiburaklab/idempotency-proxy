export type LockStatus = 'processing' | 'done'

export interface IdempotencyRecord {
  id: string
  key: string
  requestHash: string
  statusCode: number
  responseBody: unknown
  createdAt: Date
  expiresAt: Date
}

export interface StoredResponse {
  statusCode: number
  body: unknown
}
