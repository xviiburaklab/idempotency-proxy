function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback
  if (val === undefined) {
    throw new Error(`Missing required env variable: ${key}`)
  }
  return val
}

export const cfg = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  upstreamUrl: getEnv('UPSTREAM_URL'),
  redisUrl: getEnv('REDIS_URL', 'redis://localhost:6379'),
  databaseUrl: getEnv('DATABASE_URL'),
  ttlSeconds: parseInt(process.env.TTL_SECONDS ?? '86400', 10),
  // how long we hold the "processing" lock before considering a request dead
  lockTtlSeconds: parseInt(process.env.LOCK_TTL_SECONDS ?? '30', 10),
}
