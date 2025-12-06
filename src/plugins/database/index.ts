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

  // Test PostgreSQL connection (required)
  try {
    await prisma.$connect()
    fastify.log.info('PostgreSQL connection established via Prisma')
  } catch (error) {
    fastify.log.error(error, 'Failed to connect to PostgreSQL')
    throw error
  }

  // Add to Fastify instance
  fastify.decorate('prisma', prisma as any)
  fastify.decorate('redis', redis)

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await prisma.$disconnect()
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

