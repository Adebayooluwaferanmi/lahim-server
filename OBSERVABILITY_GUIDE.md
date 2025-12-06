# Observability Guide for LaHIM Server

## Overview

LaHIM server now includes comprehensive observability with:
- **OpenTelemetry**: Distributed tracing
- **Prometheus**: Metrics collection
- **Grafana**: Dashboards and visualization
- **Event Bus**: Event-driven architecture foundation

## Quick Start

### 1. Start Observability Stack

```bash
docker compose up -d prometheus grafana
```

### 2. Access Dashboards

- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3002 (admin/admin)

### 3. View Metrics

```bash
# Server metrics endpoint
curl http://localhost:3000/metrics
```

## OpenTelemetry Tracing

### Configuration

Tracing is automatically initialized when the server starts (unless `ENABLE_TRACING=false`).

### Using Tracing in Code

```typescript
import { withSpan, addSpanAttributes } from '../lib/tracing'

// Wrap an operation with a span
await withSpan('create-lab-order', async (span) => {
  span.setAttribute('patient.id', patientId)
  span.setAttribute('test.code', testCode)
  
  // Your operation
  const order = await createOrder(data)
  
  return order
})

// Add attributes to current span
await addSpanAttributes({
  'order.id': orderId,
  'order.status': 'completed',
})
```

## Prometheus Metrics

### Available Metrics

- `http_request_duration_seconds` - HTTP request duration
- `http_requests_total` - Total HTTP requests
- `http_request_errors_total` - HTTP request errors
- `active_connections` - Active connections
- `database_query_duration_seconds` - Database query duration
- `cache_hits_total` - Cache hits
- `cache_misses_total` - Cache misses

### Recording Custom Metrics

```typescript
// Database query
import { recordDatabaseQuery } from '../plugins/observability'

const startTime = Date.now()
const result = await fastify.prisma.labOrder.findMany()
const duration = (Date.now() - startTime) / 1000

recordDatabaseQuery(fastify, 'findMany', 'LabOrder', duration)

// Cache operations
import { recordCacheHit, recordCacheMiss } from '../plugins/observability'

if (cached) {
  recordCacheHit(fastify, 'redis')
} else {
  recordCacheMiss(fastify, 'redis')
}
```

## Event Bus

### Publishing Events

```typescript
import { publishLabOrderEvent } from '../lib/event-bus'

// After creating a lab order
await createLabOrder(data)

// Publish event
await publishLabOrderEvent(fastify, 'created', order.id, order)
```

### Subscribing to Events

```typescript
import { eventBus } from '../lib/event-bus'

// Subscribe to lab order events
eventBus.subscribe('lab.order.created', async (event) => {
  console.log('Lab order created:', event.aggregateId)
  // Handle event (e.g., send notification, update cache)
})
```

### Event Types

- `lab.order.created`
- `lab.order.updated`
- `lab.order.completed`
- `lab.result.created`
- `lab.result.updated`
- `lab.result.finalized`
- `specimen.collected`
- `specimen.received`
- `qc.result.entered`
- `qc.result.failed`

## Grafana Dashboards

### Pre-configured Dashboards

1. **HTTP Metrics Dashboard**
   - Request rate
   - Request duration
   - Error rate
   - Status code distribution

2. **Database Metrics Dashboard**
   - Query duration
   - Query rate
   - Connection pool metrics

3. **Cache Metrics Dashboard**
   - Hit rate
   - Miss rate
   - Cache size

### Creating Custom Dashboards

1. Go to Grafana: http://localhost:3002
2. Login (admin/admin)
3. Create new dashboard
4. Add panels with Prometheus queries

Example queries:
```promql
# Request rate
rate(http_requests_total[5m])

# Error rate
rate(http_request_errors_total[5m])

# P95 latency
histogram_quantile(0.95, http_request_duration_seconds_bucket)
```

## Production Considerations

### OpenTelemetry Exporters

For production, configure exporters:

```typescript
// In tracing.ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-otlp-http'

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
})
```

### Event Bus Migration

The current event bus is in-memory. For production:

1. **Replace with Kafka/Redpanda**:
   ```typescript
   import { Kafka } from 'kafkajs'
   
   const kafka = new Kafka({
     clientId: 'lahim-server',
     brokers: [process.env.KAFKA_BROKER],
   })
   ```

2. **Use event sourcing** for audit trail
3. **Implement event replay** for recovery

## Monitoring Alerts

### Setting Up Alerts in Prometheus

Create `prometheus/alerts.yml`:

```yaml
groups:
  - name: lahim_alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_request_errors_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "High error rate detected"
```

### Grafana Alerting

1. Create alert rules in Grafana
2. Configure notification channels (email, Slack, etc.)
3. Set alert thresholds

## Troubleshooting

### Metrics Not Appearing

1. Check `/metrics` endpoint: `curl http://localhost:3000/metrics`
2. Verify Prometheus is scraping: Check Prometheus targets
3. Check logs for errors

### Tracing Not Working

1. Verify `ENABLE_TRACING` is not set to `false`
2. Check OpenTelemetry logs
3. Verify exporters are configured correctly

### Event Bus Not Publishing

1. Check event bus is initialized in `app.ts`
2. Verify event handlers are registered
3. Check logs for event publishing errors

## Resources

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [Event-Driven Architecture](https://martinfowler.com/articles/201701-event-driven.html)

---

**Last Updated**: December 2024

