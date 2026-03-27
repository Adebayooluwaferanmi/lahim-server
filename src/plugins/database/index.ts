/**
 * Database connection plugin for PostgreSQL and Redis
 * Provides Prisma client and Redis client to Fastify instance
 */

import { FastifyPluginAsync } from 'fastify'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: any // PrismaClient - using any to avoid type conflicts
    redis: Redis | null
  }
}

const databasePlugin: FastifyPluginAsync = async (fastify) => {
  // Initialize Prisma Client
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

  // Initialize Redis Client (optional - will be null if connection fails)
  let redis: Redis | null = null
  const redisEnabled = process.env.REDIS_ENABLED !== 'false'

  if (redisEnabled) {
    try {
      redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000)
          return delay
        },
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
      })

      // Test Redis connection (non-blocking)
      try {
        await redis.connect()
        await redis.ping()
        fastify.log.info('Redis connection established')
      } catch (error) {
        fastify.log.warn({ error }, 'Redis connection failed - continuing without Redis cache')
        redis.disconnect()
        redis = null
      }
    } catch (error) {
      fastify.log.warn({ error }, 'Redis initialization failed - continuing without Redis cache')
      redis = null
    }
  } else {
    fastify.log.info('Redis disabled via REDIS_ENABLED=false')
  }

  // Test PostgreSQL connection (with shorter timeout to avoid Fastify plugin timeout)
  const postgresEnabled = process.env.POSTGRES_ENABLED !== 'false'
  let prismaClient: any = null
  
  if (postgresEnabled) {
    // Use Promise.race to add a shorter timeout (5 seconds to avoid Fastify timeout)
    const connectPromise = prisma.$connect()
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('PostgreSQL connection timeout after 5 seconds')), 5000)
    })

    try {
      await Promise.race([connectPromise, timeoutPromise])
      fastify.log.info('PostgreSQL connection established via Prisma')
      prismaClient = prisma
    } catch (error) {
      fastify.log.warn({ error: (error as Error).message }, 'PostgreSQL connection failed or timed out')
      // Don't throw - allow server to start without PostgreSQL for development
      // Services will handle missing PostgreSQL gracefully
      fastify.log.warn('Server will continue without PostgreSQL. Some features may be limited.')
      prismaClient = null
      // Disconnect the failed connection (non-blocking)
      prisma.$disconnect().catch(() => {
        // Ignore disconnect errors
      })
    }
  } else {
    fastify.log.info('PostgreSQL disabled via POSTGRES_ENABLED=false')
    prismaClient = null
  }

  // Add to Fastify instance (prisma may be null if connection failed or disabled)
  fastify.decorate('prisma', prismaClient)
  fastify.decorate('redis', redis)

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    if (prismaClient) {
      try {
        await prismaClient.$disconnect()
      } catch (error) {
        fastify.log.warn({ error }, 'Error disconnecting from PostgreSQL')
      }
    }
    if (redis) {
      redis.disconnect()
    }
    fastify.log.info('Database connections closed')
  })
}

export default fp(databasePlugin, {
  name: 'database',
  dependencies: [],
})

