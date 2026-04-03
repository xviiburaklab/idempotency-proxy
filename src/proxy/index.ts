import Fastify from 'fastify'
import { cfg } from '../config'
import { idempotencyHandler } from './middleware'
import { deleteRecord, findRecord, getStats, listRecent } from '../store/postgres'
import { closePool, deleteExpired } from '../store/postgres'
import { closeRedis } from '../store/redis'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

app.all('/*', async (req, reply) => {
  // skip the admin prefix
  if (req.url.startsWith('/admin')) {
    return reply.status(404).send({ error: 'Not found' })
  }
  await idempotencyHandler(req, reply)
})

// admin
app.get('/admin/keys/:key', async (req, reply) => {
  const { key } = req.params as { key: string }
  const record = await findRecord(key)
  if (!record) {
    return reply.status(404).send({ error: 'Key not found or expired' })
  }
  return reply.send(record)
})

app.delete('/admin/keys/:key', async (req, reply) => {
  const { key } = req.params as { key: string }
  const deleted = await deleteRecord(key)
  if (!deleted) {
    return reply.status(404).send({ error: 'Key not found' })
  }
  return reply.status(204).send()
})

app.get('/admin/stats', async (_req, reply) => {
  const stats = await getStats()
  return reply.send(stats)
})

app.get('/admin/dashboard', async (_req, reply) => {
  const records = await listRecent(50)

  const rows = records
    .map((r) => {
      const isHit = r.statusCode >= 200 && r.statusCode < 300
      const color = isHit ? '#22c55e' : '#3b82f6'
      const label = isHit ? 'cached' : 'new'
      return `
        <tr>
          <td>${r.key}</td>
          <td>${r.statusCode}</td>
          <td style="color:${color};font-weight:600">${label}</td>
          <td>${new Date(r.createdAt).toLocaleString()}</td>
          <td>${new Date(r.expiresAt).toLocaleString()}</td>
        </tr>`
    })
    .join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Idempotency Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; background: #0f172a; color: #e2e8f0; }
    h1 { margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.6rem 1rem; border-bottom: 1px solid #1e293b; }
    th { background: #1e293b; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:hover td { background: #1e293b33; }
  </style>
</head>
<body>
  <h1>Idempotency Records</h1>
  <table>
    <thead>
      <tr>
        <th>Key</th><th>Status</th><th>Cache</th><th>Created</th><th>Expires</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`

  return reply.type('text/html').send(html)
})

// cleanup job — runs every hour
const cleanupInterval = setInterval(async () => {
  try {
    const deleted = await deleteExpired()
    if (deleted > 0) {
      app.log.info({ deleted }, 'expired idempotency records cleaned up')
    }
  } catch (err) {
    app.log.error({ err }, 'cleanup job failed')
  }
}, 60 * 60 * 1000)

async function start() {
  try {
    await app.listen({ port: cfg.port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

async function shutdown() {
  clearInterval(cleanupInterval)
  await app.close()
  await closePool()
  await closeRedis()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start()
