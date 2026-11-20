// Phase 3 — OpenTelemetry tracing → Application Insights.
//
// The OTEL stack + Azure Monitor exporter is a large transitive dependency, so
// it is optionalDependencies + esbuild-external + LAZY-imported here, and only
// when telemetry is enabled. A telemetry-off install carries zero OTEL cost and
// every export call becomes a no-op.
//
// Spans use the GenAI semantic conventions (see spanHelpers.ts). Content
// recording is OFF by default and gated entirely in spanHelpers.

import {
  buildEvaluatorSpanAttributes,
  buildRunSpanAttributes,
  type SpanAttributeInput,
} from './spanHelpers'

export interface TracingConfig {
  enabled: boolean
  connectionString?: string
  recordContent: boolean
}

// Minimal structural types for the (untyped, optional) OTEL surface we use.
interface SpanLike {
  end(): void
}
interface TracerLike {
  startSpan(name: string, opts: { attributes: Record<string, string | number | boolean> }): SpanLike
}
interface ProviderLike {
  addSpanProcessor(p: unknown): void
  register(): void
  shutdown(): Promise<void>
}

let provider: ProviderLike | undefined
let tracer: TracerLike | undefined
let active = false

/** Initialize tracing if enabled and a connection string is present. Idempotent. */
export async function initTracing(config: TracingConfig): Promise<void> {
  if (active || !config.enabled || !config.connectionString) {
    return
  }
  try {
    const otelApi = (await import('@opentelemetry/api' as string)) as unknown as {
      trace: { getTracer(name: string): TracerLike }
    }
    const { NodeTracerProvider } = (await import('@opentelemetry/sdk-trace-node' as string)) as unknown as {
      NodeTracerProvider: new () => ProviderLike
    }
    const { SimpleSpanProcessor } = (await import('@opentelemetry/sdk-trace-base' as string)) as unknown as {
      SimpleSpanProcessor: new (exporter: unknown) => unknown
    }
    const { AzureMonitorTraceExporter } = (await import(
      '@azure/monitor-opentelemetry-exporter' as string
    )) as unknown as { AzureMonitorTraceExporter: new (opts: { connectionString: string }) => unknown }

    provider = new NodeTracerProvider()
    const exporter = new AzureMonitorTraceExporter({ connectionString: config.connectionString })
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
    provider.register()
    tracer = otelApi.trace.getTracer('sdlc-governance')
    active = true
  } catch {
    // OTEL packages absent or incompatible — tracing silently stays off.
    active = false
  }
}

/**
 * Record one completed evaluation run as a span tree: a parent `gen_ai.evaluate`
 * span plus a child span per evaluator. No-op when tracing is inactive.
 */
export function recordEvalRun(input: SpanAttributeInput): void {
  if (!active || !tracer) {
    return
  }
  const parent = tracer.startSpan('gen_ai.evaluate', {
    attributes: buildRunSpanAttributes(input),
  })
  for (const d of input.decision.perEvaluator) {
    const child = tracer.startSpan(`gen_ai.evaluate.${d.evaluator}`, {
      attributes: buildEvaluatorSpanAttributes(d.evaluator, d.score, d.pass),
    })
    child.end()
  }
  parent.end()
}

/** Flush and shut down the provider on extension deactivate. */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    try {
      await provider.shutdown()
    } catch {
      // best-effort flush
    }
    provider = undefined
    tracer = undefined
    active = false
  }
}

/** Test hook: whether tracing is currently active. */
export function isTracingActive(): boolean {
  return active
}
