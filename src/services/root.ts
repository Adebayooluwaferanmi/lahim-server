import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { checkDatabaseHealth } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  fastify.get('/', (_, reply) => {
    reply.send({ root: true })
  })

  // Health check endpoint
  fastify.get('/health', async (_, reply) => {
    try {
      const dbHealth = await checkDatabaseHealth(
        fastify.prisma, 
        fastify.redis,
        fastify.couchAvailable && fastify.couch ? fastify.couch : undefined
      )
      
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        databases: {
          postgres: dbHealth.postgres ? 'connected' : 'disconnected',
          redis: dbHealth.redis ? 'connected' : 'disconnected',
          couchdb: dbHealth.couchdb ? 'connected' : 'disconnected',
        },
        uptime: process.uptime(),
      }

      // Server is healthy if PostgreSQL is connected (Redis and CouchDB are optional)
      const isHealthy = dbHealth.postgres
      reply.code(isHealthy ? 200 : 503).send(health)
    } catch (error) {
      fastify.log.error(error, 'Health check failed')
      reply.code(503).send({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: 'Health check failed',
      })
    }
  })

  next()
}
