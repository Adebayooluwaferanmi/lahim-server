/**
 * Database utility functions
 * Helper functions for common database operations
 */

// import { PrismaClient } from '@prisma/client' // Using any to avoid type conflicts
import Redis from 'ioredis'

/**
 * Cache helper for Redis (with null-safe fallback)
 */
export class CacheHelper {
  constructor(private redis: Redis | null) {}

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null
    try {
      const value = await this.redis.get(key)
      if (!value) return null
      try {
        return JSON.parse(value) as T
      } catch {
        return value as T
      }
    } catch {
      return null
    }
  }

  /**
   * Set cached value with optional TTL
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    if (!this.redis) return
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value)
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, serialized)
      } else {
        await this.redis.set(key, serialized)
      }
    } catch {
      // Silently fail if Redis is unavailable
    }
  }

  /**
   * Delete cached value
   */
  async delete(key: string): Promise<void> {
    if (!this.redis) return
    try {
      await this.redis.del(key)
    } catch {
      // Silently fail if Redis is unavailable
    }
  }

  /**
   * Delete all keys matching pattern
   */
  async deletePattern(pattern: string): Promise<void> {
    if (!this.redis) return
    try {
      const keys = await this.redis.keys(pattern)
      if (keys.length > 0) {
        await this.redis.del(...keys)
      }
    } catch {
      // Silently fail if Redis is unavailable
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.redis) return false
    try {
      const result = await this.redis.exists(key)
      return result === 1
    } catch {
      return false
    }
  }
}

/**
 * Database transaction helper
 */
export async function withTransaction<T>(
  prisma: any, // PrismaClient
  callback: (tx: any) => Promise<T> // tx: PrismaClient
): Promise<T> {
  return prisma.$transaction(callback)
}

/**
 * Pagination helper
 */
export interface PaginationParams {
  page?: number
  limit?: number
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export async function paginate<T>(
  query: Promise<[T[], number]>,
  page: number = 1,
  limit: number = 20
): Promise<PaginatedResult<T>> {
  const [data, total] = await query
  const totalPages = Math.ceil(total / limit)

  return {
    data,
    total,
    page,
    limit,
    totalPages,
  }
}

/**
 * Health check for databases
 */
export async function checkDatabaseHealth(
  prisma: any, // PrismaClient
  redis: Redis | null,
  couch?: any // ServerScope
): Promise<{ postgres: boolean; redis: boolean; couchdb: boolean }> {
  const health = {
    postgres: false,
    redis: false,
    couchdb: false,
  }

  try {
    await prisma.$queryRaw`SELECT 1`
    health.postgres = true
  } catch (error) {
    console.error('PostgreSQL health check failed:', error)
  }

  if (redis) {
    try {
      await redis.ping()
      health.redis = true
    } catch (error) {
      console.error('Redis health check failed:', error)
    }
  }

  if (couch) {
    try {
      await couch.db.list()
      health.couchdb = true
    } catch (error) {
      console.error('CouchDB health check failed:', error)
    }
  }

  return health
}

/**
 * CouchDB index creation helper with retry logic
 * @param db - CouchDB database instance
 * @param indexDef - Index definition
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param retryDelay - Initial delay between retries in ms (default: 1000)
 * @returns Promise that resolves when index is created or rejects after max retries
 */
export async function createCouchDBIndex(
  db: any,
  indexDef: { index: { fields: string[] }; name: string },
  maxRetries: number = 3,
  retryDelay: number = 1000
): Promise<void> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await db.createIndex(indexDef)
      return // Success
    } catch (error: any) {
      lastError = error
      const errorMessage = error?.message || String(error)
      
      // If index already exists, that's fine
      if (errorMessage.includes('already exists') || errorMessage.includes('file_exists')) {
        return
      }
      
      // If connection refused, wait and retry
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        if (attempt < maxRetries - 1) {
          // Exponential backoff: delay * 2^attempt
          const delay = retryDelay * Math.pow(2, attempt)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      
      // For other errors, don't retry
      throw error
    }
  }
  
  // If we exhausted retries, throw the last error
  throw lastError || new Error('Failed to create index after retries')
}

/**
 * Safely create CouchDB indexes with connection checking
 * @param fastify - Fastify instance
 * @param dbName - Database name
 * @param indexes - Array of index definitions
 * @param serviceName - Name of the service (for logging)
 */
export async function createCouchDBIndexes(
  fastify: any, // FastifyInstance
  dbName: string,
  indexes: Array<{ index: { fields: string[] }; name: string }>,
  serviceName: string
): Promise<void> {
  // Check if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn(
      `CouchDB not available - skipping index creation for ${serviceName}`
    )
    return
  }

  try {
    const db = fastify.couch.db.use(dbName)
    
    // Create all indexes with retry logic
    for (const indexDef of indexes) {
      try {
        await createCouchDBIndex(db, indexDef)
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        // Log warning but continue with other indexes
        if (!errorMessage.includes('already exists') && !errorMessage.includes('file_exists')) {
          fastify.log.warn(
            { error: errorMessage, index: indexDef.name, db: dbName },
            `Failed to create index ${indexDef.name} for ${serviceName}`
          )
        }
      }
    }
    
    fastify.log.info(`${serviceName} indexes created/verified`)
  } catch (error: any) {
    const errorMessage = error?.message || String(error)
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      fastify.log.warn(
        { 
          error: errorMessage,
          db: dbName,
          hint: 'CouchDB is not available. Start CouchDB or set COUCHDB_ENABLED=false to disable.'
        },
        `Failed to create ${serviceName} indexes - CouchDB not available`
      )
    } else {
      fastify.log.warn(
        { error },
        `Failed to create ${serviceName} indexes (may already exist)`
      )
    }
  }
}

/**
 * Ensure a CouchDB database exists, create it if it doesn't
 * @param fastify - Fastify instance
 * @param dbName - Database name
 * @returns Promise that resolves when database is ready
 * @throws Error if database cannot be created and doesn't exist
 */
export async function ensureCouchDBDatabase(
  fastify: any, // FastifyInstance
  dbName: string
): Promise<void> {
  if (!fastify.couchAvailable || !fastify.couch) {
    const error = new Error(`CouchDB not available - cannot ensure database ${dbName}`)
    fastify.log.warn(error.message)
    throw error
  }

  try {
    // Try to create the database - it will fail if it already exists, which is fine
    await fastify.couch.db.create(dbName)
    fastify.log.info(`Created CouchDB database: ${dbName}`)
  } catch (error: any) {
    const errorMessage = error?.message || String(error)
    
    // If database already exists, that's fine - verify it's accessible
    if (
      errorMessage.includes('file_exists') || 
      errorMessage.includes('already exists') ||
      errorMessage.includes('Database already exists')
    ) {
      fastify.log.debug(`CouchDB database ${dbName} already exists`)
      
      // Verify the database is accessible by trying to use it
      try {
        const testDb = fastify.couch.db.use(dbName)
        // Try a simple operation to verify the database exists
        await testDb.info()
        return
      } catch (verifyError: any) {
        const verifyMessage = verifyError?.message || String(verifyError)
        if (verifyMessage.includes('does not exist') || verifyMessage.includes('not found')) {
          // Database doesn't actually exist, try creating again
          fastify.log.warn(`Database ${dbName} reported as existing but not accessible, attempting to create`)
          try {
            await fastify.couch.db.create(dbName)
            fastify.log.info(`Created CouchDB database: ${dbName} (retry)`)
            return
          } catch (retryError: any) {
            throw new Error(`Failed to create CouchDB database ${dbName} after retry: ${retryError?.message || String(retryError)}`)
          }
        }
        // Other errors during verification are fine - database exists
        return
      }
    }
    
    // For other errors, throw so caller can handle it
    fastify.log.error(
      { error: errorMessage, db: dbName },
      `Failed to ensure CouchDB database ${dbName}`
    )
    throw new Error(`Failed to create CouchDB database ${dbName}: ${errorMessage}`)
  }
}

