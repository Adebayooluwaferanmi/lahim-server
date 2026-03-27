/**
 * OpenTelemetry Tracing Setup
 * Provides distributed tracing across services
 */

// Temporarily disabled due to OpenTelemetry version compatibility issues
// import { NodeSDK } from '@opentelemetry/sdk-node'
// import { Resource } from '@opentelemetry/resources'
// import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
// Note: OpenTelemetry metrics are handled separately via Prometheus plugin
// This file focuses on tracing only
// Auto-instrumentations can be added later if needed

/**
 * Initialize OpenTelemetry SDK
 * Note: Currently disabled due to version compatibility issues
 * Can be enabled once OpenTelemetry packages are aligned
 */
export function initializeTracing() {
  // Temporarily disabled due to OpenTelemetry version compatibility issues
  // Will be re-enabled once package versions are aligned
  console.log('OpenTelemetry tracing is temporarily disabled due to version compatibility issues')
  return null
}

/**
 * Create a span for custom operations
 */
export async function withSpan<T>(
  name: string,
  fn: (span: any) => Promise<T>
): Promise<T> {
  const { trace } = await import('@opentelemetry/api')
  const tracer = trace.getTracer('lahim-server')
  const span = tracer.startSpan(name) as any

  try {
    const result = await fn(span)
    span.setStatus({ code: 1 }) // OK
    return result
  } catch (error: any) {
    span.setStatus({ code: 2, message: error.message }) // ERROR
    span.recordException(error)
    throw error
  } finally {
    span.end()
  }
}

/**
 * Add attributes to current span
 */
export async function addSpanAttributes(attributes: Record<string, string | number | boolean>) {
  const { trace } = await import('@opentelemetry/api')
  const span = trace.getActiveSpan()
  if (span) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value)
    })
  }
}

