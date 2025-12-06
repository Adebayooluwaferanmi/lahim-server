# Dual-Write Pattern Implementation

## Overview

The dual-write pattern allows LaHIM to write data to both **CouchDB** (for offline sync) and **PostgreSQL** (for complex queries and analytics) simultaneously. This ensures:

1. **Offline Sync**: CouchDB maintains offline-first capabilities
2. **Complex Queries**: PostgreSQL enables advanced analytics and reporting
3. **Data Consistency**: Both databases stay in sync
4. **Graceful Degradation**: System continues working if one database fails

## Architecture

```
┌─────────────────────────────────────┐
│      Application Service            │
│                                     │
│  ┌──────────────────────────────┐ │
│  │   Dual-Write Helper          │ │
│  │                              │ │
│  │  ┌──────────┐  ┌──────────┐ │ │
│  │  │PostgreSQL│  │ CouchDB  │ │ │
│  │  │ (Primary)│  │(Secondary)│ │ │
│  │  └──────────┘  └──────────┘ │ │
│  └──────────────────────────────┘ │
└─────────────────────────────────────┘
```

## Implementation

### Core Components

1. **DualWriteHelper** (`src/lib/dual-write.ts`)
   - Generic dual-write utility
   - Retry logic
   - Error handling
   - Conflict resolution

2. **Dual-Write Services** (`src/services/dual-write-service.ts`)
   - Entity-specific implementations
   - Type-safe operations
   - Business logic integration

### Usage Example

```typescript
import { createDualWriteHelper } from '../lib/dual-write'

// In a service
const dualWrite = createDualWriteHelper(fastify, 'lab-orders')

// Create a lab order
const result = await dualWrite.write({
  _id: 'order-123',
  patientId: 'patient-456',
  testCodeLoinc: '12345-6',
  status: 'requested',
  type: 'lab_order',
})

if (result.overall) {
  // Success - data written to both databases
} else {
  // Handle partial failure
  if (!result.postgres.success) {
    // PostgreSQL write failed - critical
  }
  if (!result.couchdb.success) {
    // CouchDB write failed - log but continue
  }
}
```

### Entity-Specific Service

```typescript
import { LabOrderDualWriteService } from './dual-write-service'

// Initialize
const labOrderService = new LabOrderDualWriteService(fastify)

// Create
const result = await labOrderService.createLabOrder({
  patientId: 'patient-456',
  testCodeLoinc: '12345-6',
  status: 'requested',
})

// Update
await labOrderService.updateLabOrder('order-123', {
  status: 'collected',
  collectedAt: new Date(),
})

// Query (from PostgreSQL)
const orders = await labOrderService.listLabOrders({
  patientId: 'patient-456',
  status: 'pending',
  page: 1,
  limit: 20,
})
```

## Write Strategy

### Primary: PostgreSQL
- **Why**: Complex queries, analytics, transactions
- **Failure Handling**: Fail request if PostgreSQL write fails
- **Retry Logic**: 3 retries with exponential backoff

### Secondary: CouchDB
- **Why**: Offline sync, PouchDB compatibility
- **Failure Handling**: Log warning but continue if CouchDB write fails
- **Retry Logic**: 3 retries with exponential backoff

## Read Strategy

### Queries: PostgreSQL
- All list/query operations use PostgreSQL
- Better performance for complex queries
- Supports joins, aggregations, filtering

### Offline Sync: CouchDB
- PouchDB syncs from CouchDB
- Maintains offline-first capabilities
- Conflict resolution handled by CouchDB

## Error Handling

### PostgreSQL Write Failure
```typescript
// Critical - fail the request
if (!result.postgres.success) {
  throw new Error('Failed to write to PostgreSQL')
}
```

### CouchDB Write Failure
```typescript
// Non-critical - log and continue
if (!result.couchdb.success) {
  fastify.log.warn('CouchDB write failed, but PostgreSQL succeeded')
  // Optionally queue for retry
}
```

## Retry Logic

```typescript
const options = {
  retries: 3,           // Number of retry attempts
  retryDelay: 1000,     // Initial delay in ms
  failOnCouchDB: false, // Don't fail if CouchDB fails
  failOnPostgres: true,  // Fail if PostgreSQL fails
}

const result = await dualWrite.write(data, options)
```

## Migration Strategy

### Phase 1: Dual-Write (Current)
- Write to both databases
- Read from PostgreSQL for queries
- Read from CouchDB for offline sync

### Phase 2: Gradual Migration
- Migrate existing CouchDB data to PostgreSQL
- Use sync utility to backfill
- Verify data consistency

### Phase 3: Full Migration
- All new data in PostgreSQL
- CouchDB used only for offline sync
- Periodic sync from PostgreSQL to CouchDB

## Sync Utility

```typescript
// Sync existing CouchDB data to PostgreSQL
const helper = createDualWriteHelper(fastify, 'lab-orders')
const result = await helper.syncFromCouchDB(100, (processed, total) => {
  console.log(`Synced ${processed}/${total} documents`)
})
```

## Monitoring

### Metrics to Track
- Dual-write success rate
- PostgreSQL write latency
- CouchDB write latency
- Retry counts
- Failure rates by database

### Logging
```typescript
fastify.log.info({
  operation: 'dual-write',
  entity: 'lab-order',
  postgres: result.postgres.success,
  couchdb: result.couchdb.success,
}, 'Dual-write completed')
```

## Best Practices

1. **Always write to PostgreSQL first** (primary database)
2. **Don't fail if CouchDB write fails** (non-critical)
3. **Use transactions for related writes** (PostgreSQL)
4. **Monitor both databases** for consistency
5. **Implement sync utility** for data migration
6. **Log all dual-write operations** for debugging

## Troubleshooting

### PostgreSQL Write Fails
- Check database connection
- Verify schema is up to date
- Check for constraint violations
- Review error logs

### CouchDB Write Fails
- Check database connection
- Verify document structure
- Check for conflicts (_rev mismatch)
- Review error logs

### Data Inconsistency
- Run sync utility to backfill
- Compare counts between databases
- Check for missing documents
- Review write logs

## Future Enhancements

1. **Event Sourcing**: Use event bus for writes
2. **CDC (Change Data Capture)**: Automatic sync from PostgreSQL to CouchDB
3. **Conflict Resolution**: Automatic conflict detection and resolution
4. **Monitoring Dashboard**: Real-time dual-write metrics
5. **Automated Testing**: Test dual-write scenarios

## Resources

- [Dual-Write Pattern](https://microservices.io/patterns/data/dual-write.html)
- [CQRS Pattern](https://martinfowler.com/bliki/CQRS.html)
- [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)

---

**Status**: Implementation Complete  
**Last Updated**: December 2024

