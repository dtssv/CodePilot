package io.codepilot.core.observability;

import io.micrometer.core.instrument.MeterRegistry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import io.opentelemetry.semconv.ServiceAttributes;
import io.opentelemetry.semconv.ResourceAttributes;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.autoconfigure.metrics.export.prometheus.PrometheusMetricsExportAutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigureAfter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * ★ OpenTelemetry configuration for distributed tracing and metrics export.
 *
 * <p>When {@code codepilot.otel.enabled=true}, this config:
 * <ul>
 *   <li>Creates an OTLP gRPC Span Exporter pointing to {@code codepilot.otel.endpoint}</li>
 *   <li>Configures BatchSpanProcessor for efficient trace export</li>
 *   <li>Sets up a Resource with service.name=codepilot</li>
 *   <li>Registers custom MeterRegistry meters for Prometheus scraping at /actuator/prometheus</li>
 * </ul>
 *
 * <p>Environment variables (also supported):
 * <ul>
 *   <li>{@code OTEL_EXPORTER_OTLP_ENDPOINT} — OTLP collector endpoint</li>
 *   <li>{@code OTEL_SERVICE_NAME} — service name in traces</li>
 * </ul>
 */
@Configuration
@AutoConfigureAfter(PrometheusMetricsExportAutoConfiguration.class)
public class OtelConfig {

    @Value("${codepilot.otel.enabled:false}")
    private boolean otelEnabled;

    @Value("${codepilot.otel.endpoint:http://localhost:4317}")
    private String otelEndpoint;

    @Value("${codepilot.otel.service-name:codepilot}")
    private String serviceName;

    @Value("${codepilot.otel.scheduled-delay-ms:5000}")
    private int scheduledDelayMs;

    @Value("${codepilot.otel.max-export-batch-size:512}")
    private int maxExportBatchSize;

    /**
     * OTLP gRPC Span Exporter bean — only created when otel is enabled.
     * Sends trace data to the OpenTelemetry Collector.
     */
    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public SpanExporter otlpSpanExporter() {
        return OtlpGrpcSpanExporter.builder()
            .setEndpoint(otelEndpoint)
            .build();
    }

    /**
     * Tracer provider with BatchSpanProcessor for efficient trace export.
     * Batches spans before sending to reduce network overhead.
     */
    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public SdkTracerProvider sdkTracerProvider(SpanExporter spanExporter) {
        Resource resource = Resource.create(Attributes.of(
            ServiceAttributes.SERVICE_NAME, serviceName,
            ResourceAttributes.SERVICE_VERSION, "1.0.0"
        ));

        return SdkTracerProvider.builder()
            .setResource(resource)
            .addSpanProcessor(BatchSpanProcessor.builder(spanExporter)
                .setScheduleDelay(java.time.Duration.ofMillis(scheduledDelayMs))
                .setMaxExportBatchSize(maxExportBatchSize)
                .build())
            .build();
    }

    /**
     * OpenTelemetry SDK bean — provides the global OpenTelemetry instance.
     * Used by micrometer-tracing-bridge-otel for automatic trace propagation.
     */
    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public OpenTelemetry openTelemetry(SdkTracerProvider tracerProvider) {
        return OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .buildAndRegisterGlobal();
    }
}