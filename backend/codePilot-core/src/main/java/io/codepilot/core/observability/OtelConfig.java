package io.codepilot.core.observability;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.metrics.OtlpGrpcMetricExporter;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import io.opentelemetry.semconv.ServiceAttributes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

/**
 * OpenTelemetry configuration for distributed tracing and metrics export.
 *
 * <p>Enabled when {@code codepilot.otel.enabled=true} in application config.
 * Exports traces to an OTLP-compatible backend (Jaeger, Tempo, etc.)
 * and metrics to Prometheus/Grafana via OTLP.
 *
 * <p>traceId is propagated from the plugin through the gateway to all services,
 * enabling full request tracing across the entire stack.
 */
@Configuration
public class OtelConfig {

    private static final Logger log = LoggerFactory.getLogger(OtelConfig.class);

    @Value("${codepilot.otel.endpoint:http://localhost:4317}")
    private String otlpEndpoint;

    @Value("${codepilot.otel.export-interval:10s}")
    private Duration exportInterval;

    @Value("${spring.application.name:codepilot-backend}")
    private String serviceName;

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public SpanExporter otlpSpanExporter() {
        log.info("Configuring OTLP span exporter with endpoint: {}", otlpEndpoint);
        return OtlpGrpcSpanExporter.builder()
                .setEndpoint(otlpEndpoint)
                .setTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public SdkTracerProvider sdkTracerProvider(SpanExporter spanExporter) {
        Resource resource = Resource.create(Attributes.of(
                ServiceAttributes.SERVICE_NAME, serviceName,
                ServiceAttributes.SERVICE_VERSION, "1.0.0"
        ));
        return SdkTracerProvider.builder()
                .setResource(resource)
                .addSpanProcessor(BatchSpanProcessor.builder(spanExporter)
                        .setScheduleDelay(Duration.ofSeconds(5))
                        .setMaxExportBatchSize(512)
                        .build())
                .build();
    }

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public OtlpGrpcMetricExporter otlpMetricExporter() {
        log.info("Configuring OTLP metric exporter with endpoint: {}", otlpEndpoint);
        return OtlpGrpcMetricExporter.builder()
                .setEndpoint(otlpEndpoint)
                .setTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public SdkMeterProvider sdkMeterProvider(OtlpGrpcMetricExporter metricExporter) {
        Resource resource = Resource.create(Attributes.of(
                ServiceAttributes.SERVICE_NAME, serviceName
        ));
        return SdkMeterProvider.builder()
                .setResource(resource)
                .registerMetricReader(PeriodicMetricReader.builder(metricExporter)
                        .setInterval(exportInterval)
                        .build())
                .build();
    }

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public OpenTelemetry openTelemetry(SdkTracerProvider tracerProvider, SdkMeterProvider meterProvider) {
        return OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .setMeterProvider(meterProvider)
                .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
                .build();
    }

    @Bean
    @ConditionalOnProperty(name = "codepilot.otel.enabled", havingValue = "true")
    public Tracer codePilotTracer(OpenTelemetry openTelemetry) {
        return openTelemetry.getTracer("codepilot-backend", "1.0.0");
    }
}