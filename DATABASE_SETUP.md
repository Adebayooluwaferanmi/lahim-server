# Database Setup Guide

This guide explains how to set up PostgreSQL and Redis for LaHIM, alongside the existing CouchDB setup.

## Overview

LaHIM uses a **hybrid database strategy**:
- **PostgreSQL**: Primary database for complex queries, analytics, and structured data
- **CouchDB**: Offline sync service (maintains existing functionality)
- **Redis**: Caching, sessions, and real-time data

## Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ and Yarn installed

## Quick Start

### 1. Start All Databases

From the project root:

```bash
docker compose up -d
```

This will start:
- CouchDB on port 5984
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cd packages/server
cp .env.example .env
```

The `.env` file should contain:

```env
# CouchDB (for offline sync)
COUCHDB_URL="http://dev:dev@localhost:5984"

# PostgreSQL (primary database)
DATABASE_URL="postgresql://lahim:lahim_dev@localhost:5432/lahim?schema=public"

# Redis (for caching)
REDIS_HOST="localhost"
REDIS_PORT="6379"
REDIS_PASSWORD=""
```

### 3. Install Dependencies

```bash
cd packages/server
yarn install
```

### 4. Set Up PostgreSQL Schema

Generate Prisma client and run migrations:

```bash
# Generate Prisma client
yarn db:generate

# Run database migrations
yarn db:migrate
```

### 5. Verify Setup

Start the server and check the health endpoint:

```bash
yarn dev:start
```

Visit: http://localhost:3000/health

You should see:

```json
{
  "status": "ok",
  "timestamp": "2024-12-XX...",
  "databases": {
    "postgres": "connected",
    "redis": "connected",
    "couchdb": "connected"
  },
  "uptime": 123.45
}
```

## Database Access

### PostgreSQL

**Connection Details:**
- Host: `localhost`
- Port: `5432`
- Database: `lahim`
- Username: `lahim`
- Password: `lahim_dev`

**Using psql:**
```bash
psql -h localhost -U lahim -d lahim
# Password: lahim_dev
```

**Using Prisma Studio (GUI):**
```bash
yarn db:studio
```
Opens at: http://localhost:5555

### Redis

**Connection Details:**
- Host: `localhost`
- Port: `6379`
- Password: (none)

**Using redis-cli:**
```bash
redis-cli -h localhost -p 6379
```

### CouchDB

**Connection Details:**
- URL: `http://dev:dev@localhost:5984`
- Admin UI: http://localhost:5984/_utils

## Database Schema

The PostgreSQL schema includes:

- **LabOrder**: Test orders (pre-analytical)
- **LabSpecimen**: Specimen tracking
- **LabResult**: Lab results (analytical)
- **LabMicroOrganism**: Microbiology organisms
- **LabMicroSusceptibility**: Antibiotic susceptibilities
- **VocabularyCache**: Cached vocabulary data
- **QcResult**: Quality control results
- **Worklist**: Worklist management
- **WorklistItem**: Worklist items

See `prisma/schema.prisma` for full schema definition.

## Development Workflow

### Creating Migrations

When you modify the Prisma schema:

```bash
# Create a new migration
yarn db:migrate

# This will:
# 1. Create a migration file
# 2. Apply it to the database
# 3. Regenerate Prisma client
```

### Resetting Database

```bash
# Reset database (WARNING: deletes all data)
yarn prisma migrate reset
```

### Viewing Database

```bash
# Open Prisma Studio
yarn db:studio
```

## Using the Databases in Code

### PostgreSQL (Prisma)

```typescript
// In a Fastify route
fastify.get('/lab-orders', async (request, reply) => {
  const orders = await fastify.prisma.labOrder.findMany({
    include: {
      specimens: true,
      results: true,
    },
  })
  return orders
})
```

### Redis (Caching)

```typescript
// In a Fastify route
import { CacheHelper } from '../lib/db-utils'

fastify.get('/cached-data', async (request, reply) => {
  const cache = new CacheHelper(fastify.redis)
  
  // Try cache first
  const cached = await cache.get('my-key')
  if (cached) return cached
  
  // Fetch from database
  const data = await fetchData()
  
  // Cache for 1 hour
  await cache.set('my-key', data, 3600)
  
  return data
})
```

### CouchDB (Offline Sync)

```typescript
// Existing CouchDB usage continues to work
const db = fastify.couchdb.use('lab-orders')
const doc = await db.get(orderId)
```

## Production Considerations

### PostgreSQL

- Use connection pooling (Prisma handles this)
- Set up regular backups
- Consider read replicas for analytics
- Use managed services (AWS RDS, Google Cloud SQL, Azure Database)

### Redis

- Use Redis Cluster for high availability
- Set up persistence (AOF or RDB)
- Consider managed services (AWS ElastiCache, Redis Cloud)

### CouchDB

- Maintain existing CouchDB setup for offline sync
- Consider CouchDB Cloud for managed service

## Troubleshooting

### PostgreSQL Connection Failed

1. Check if container is running: `docker ps`
2. Check logs: `docker logs hr-postgres`
3. Verify DATABASE_URL in `.env`
4. Test connection: `psql -h localhost -U lahim -d lahim`

### Redis Connection Failed

1. Check if container is running: `docker ps`
2. Check logs: `docker logs hr-redis`
3. Verify REDIS_HOST and REDIS_PORT in `.env`
4. Test connection: `redis-cli -h localhost -p 6379 ping`

### Prisma Migration Issues

1. Check Prisma schema syntax: `yarn prisma validate`
2. Reset if needed: `yarn prisma migrate reset`
3. Check migration files in `prisma/migrations/`

## Next Steps

- [ ] Set up database seeding scripts
- [ ] Implement dual-write pattern (CouchDB + PostgreSQL)
- [ ] Add database connection pooling configuration
- [ ] Set up database monitoring and alerts
- [ ] Create backup and restore procedures

## Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Redis Documentation](https://redis.io/docs/)
- [CouchDB Documentation](https://docs.couchdb.org/)

