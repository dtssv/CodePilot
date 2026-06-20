package org.gradle.accessors.dm;

import org.jspecify.annotations.NullMarked;
import org.gradle.api.artifacts.MinimalExternalModuleDependency;
import org.gradle.plugin.use.PluginDependency;
import org.gradle.api.artifacts.ExternalModuleDependencyBundle;
import org.gradle.api.artifacts.MutableVersionConstraint;
import org.gradle.api.provider.Provider;
import org.gradle.api.model.ObjectFactory;
import org.gradle.api.provider.ProviderFactory;
import org.gradle.api.internal.catalog.AbstractExternalDependencyFactory;
import org.gradle.api.internal.catalog.DefaultVersionCatalog;
import java.util.Map;
import org.gradle.api.internal.attributes.AttributesFactory;
import org.gradle.api.internal.artifacts.dsl.CapabilityNotationParser;
import javax.inject.Inject;
import org.gradle.api.GradleException;

/**
 * A catalog of dependencies accessible via the {@code libs} extension.
 */
@NullMarked
public class LibrariesForLibsInPluginsBlock extends AbstractExternalDependencyFactory {

    private final AbstractExternalDependencyFactory owner = this;
    private final ApacheLibraryAccessors laccForApacheLibraryAccessors = new ApacheLibraryAccessors(owner);
    private final AssertjLibraryAccessors laccForAssertjLibraryAccessors = new AssertjLibraryAccessors(owner);
    private final BouncycastleLibraryAccessors laccForBouncycastleLibraryAccessors = new BouncycastleLibraryAccessors(owner);
    private final Bucket4jLibraryAccessors laccForBucket4jLibraryAccessors = new Bucket4jLibraryAccessors(owner);
    private final JacksonLibraryAccessors laccForJacksonLibraryAccessors = new JacksonLibraryAccessors(owner);
    private final JsonLibraryAccessors laccForJsonLibraryAccessors = new JsonLibraryAccessors(owner);
    private final JunitLibraryAccessors laccForJunitLibraryAccessors = new JunitLibraryAccessors(owner);
    private final MapstructLibraryAccessors laccForMapstructLibraryAccessors = new MapstructLibraryAccessors(owner);
    private final MicrometerLibraryAccessors laccForMicrometerLibraryAccessors = new MicrometerLibraryAccessors(owner);
    private final MysqlLibraryAccessors laccForMysqlLibraryAccessors = new MysqlLibraryAccessors(owner);
    private final NimbusLibraryAccessors laccForNimbusLibraryAccessors = new NimbusLibraryAccessors(owner);
    private final OtelLibraryAccessors laccForOtelLibraryAccessors = new OtelLibraryAccessors(owner);
    private final Resilience4jLibraryAccessors laccForResilience4jLibraryAccessors = new Resilience4jLibraryAccessors(owner);
    private final SpringLibraryAccessors laccForSpringLibraryAccessors = new SpringLibraryAccessors(owner);
    private final SpringdocLibraryAccessors laccForSpringdocLibraryAccessors = new SpringdocLibraryAccessors(owner);
    private final TestcontainersLibraryAccessors laccForTestcontainersLibraryAccessors = new TestcontainersLibraryAccessors(owner);
    private final WiremockLibraryAccessors laccForWiremockLibraryAccessors = new WiremockLibraryAccessors(owner);
    private final VersionAccessors vaccForVersionAccessors = new VersionAccessors(providers, config);
    private final BundleAccessors baccForBundleAccessors = new BundleAccessors(objects, providers, config, attributesFactory, capabilityNotationParser);
    private final PluginAccessors paccForPluginAccessors = new PluginAccessors(providers, config);

    @Inject
    public LibrariesForLibsInPluginsBlock(DefaultVersionCatalog config, ProviderFactory providers, ObjectFactory objects, AttributesFactory attributesFactory, CapabilityNotationParser capabilityNotationParser) {
        super(config, providers, objects, attributesFactory, capabilityNotationParser);
    }

    /**
     * Dependency provider for <b>awaitility</b> with <b>org.awaitility:awaitility</b> coordinates and
     * with version reference <b>awaitility</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getAwaitility() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>caffeine</b> with <b>com.github.ben-manes.caffeine:caffeine</b> coordinates and
     * with version reference <b>caffeine</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getCaffeine() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>guava</b> with <b>com.google.guava:guava</b> coordinates and
     * with version reference <b>guava</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getGuava() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>hikari</b> with <b>com.zaxxer:HikariCP</b> coordinates and
     * with version reference <b>hikari</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getHikari() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>jtokkit</b> with <b>com.knuddels:jtokkit</b> coordinates and
     * with version reference <b>jtokkit</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getJtokkit() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>okhttp</b> with <b>com.squareup.okhttp3:okhttp</b> coordinates and
     * with version reference <b>okhttp</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getOkhttp() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Dependency provider for <b>pgvector</b> with <b>com.pgvector:pgvector</b> coordinates and
     * with version reference <b>pgvector</b>
     * <p>
     * This dependency was declared in catalog libs.versions.toml
     */
    public Provider<MinimalExternalModuleDependency> getPgvector() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>apache</b>
     */
    public ApacheLibraryAccessors getApache() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>assertj</b>
     */
    public AssertjLibraryAccessors getAssertj() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>bouncycastle</b>
     */
    public BouncycastleLibraryAccessors getBouncycastle() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>bucket4j</b>
     */
    public Bucket4jLibraryAccessors getBucket4j() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>jackson</b>
     */
    public JacksonLibraryAccessors getJackson() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>json</b>
     */
    public JsonLibraryAccessors getJson() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>junit</b>
     */
    public JunitLibraryAccessors getJunit() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>mapstruct</b>
     */
    public MapstructLibraryAccessors getMapstruct() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>micrometer</b>
     */
    public MicrometerLibraryAccessors getMicrometer() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>mysql</b>
     */
    public MysqlLibraryAccessors getMysql() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>nimbus</b>
     */
    public NimbusLibraryAccessors getNimbus() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>otel</b>
     */
    public OtelLibraryAccessors getOtel() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>resilience4j</b>
     */
    public Resilience4jLibraryAccessors getResilience4j() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>spring</b>
     */
    public SpringLibraryAccessors getSpring() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>springdoc</b>
     */
    public SpringdocLibraryAccessors getSpringdoc() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>testcontainers</b>
     */
    public TestcontainersLibraryAccessors getTestcontainers() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of libraries at <b>wiremock</b>
     */
    public WiremockLibraryAccessors getWiremock() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of versions at <b>versions</b>
     */
    public VersionAccessors getVersions() {
        return vaccForVersionAccessors;
    }

    /**
     * Group of bundles at <b>bundles</b>
     */
    public BundleAccessors getBundles() {
        throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
    }

    /**
     * Group of plugins at <b>plugins</b>
     */
    public PluginAccessors getPlugins() {
        return paccForPluginAccessors;
    }

    public static class ApacheLibraryAccessors extends SubDependencyFactory {
        private final ApacheCommonsLibraryAccessors laccForApacheCommonsLibraryAccessors = new ApacheCommonsLibraryAccessors(owner);

        public ApacheLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>apache.commons</b>
         */
        public ApacheCommonsLibraryAccessors getCommons() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class ApacheCommonsLibraryAccessors extends SubDependencyFactory {

        public ApacheCommonsLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>compress</b> with <b>org.apache.commons:commons-compress</b> coordinates and
         * with version reference <b>apache.commons.compress</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getCompress() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>lang3</b> with <b>org.apache.commons:commons-lang3</b> coordinates and
         * with version reference <b>apache.commons.lang</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getLang3() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class AssertjLibraryAccessors extends SubDependencyFactory {

        public AssertjLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>core</b> with <b>org.assertj:assertj-core</b> coordinates and
         * with version reference <b>assertj</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getCore() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class BouncycastleLibraryAccessors extends SubDependencyFactory {

        public BouncycastleLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>bcpkix</b> with <b>org.bouncycastle:bcpkix-jdk18on</b> coordinates and
         * with version reference <b>bouncycastle</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getBcpkix() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class Bucket4jLibraryAccessors extends SubDependencyFactory {

        public Bucket4jLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>core</b> with <b>com.bucket4j:bucket4j-core</b> coordinates and
         * with version reference <b>bucket4j</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getCore() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class JacksonLibraryAccessors extends SubDependencyFactory {

        public JacksonLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>bom</b> with <b>com.fasterxml.jackson:jackson-bom</b> coordinates and
         * with version reference <b>jackson</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getBom() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class JsonLibraryAccessors extends SubDependencyFactory {
        private final JsonSchemaLibraryAccessors laccForJsonSchemaLibraryAccessors = new JsonSchemaLibraryAccessors(owner);

        public JsonLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>json.schema</b>
         */
        public JsonSchemaLibraryAccessors getSchema() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class JsonSchemaLibraryAccessors extends SubDependencyFactory {

        public JsonSchemaLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>validator</b> with <b>com.networknt:json-schema-validator</b> coordinates and
         * with version reference <b>json.schema</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getValidator() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class JunitLibraryAccessors extends SubDependencyFactory {

        public JunitLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>jupiter</b> with <b>org.junit.jupiter:junit-jupiter</b> coordinates and
         * with version reference <b>junit</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getJupiter() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class MapstructLibraryAccessors extends SubDependencyFactory implements DependencyNotationSupplier {

        public MapstructLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>mapstruct</b> with <b>org.mapstruct:mapstruct</b> coordinates and
         * with version reference <b>mapstruct</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> asProvider() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>processor</b> with <b>org.mapstruct:mapstruct-processor</b> coordinates and
         * with version reference <b>mapstruct</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getProcessor() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class MicrometerLibraryAccessors extends SubDependencyFactory {
        private final MicrometerTracingLibraryAccessors laccForMicrometerTracingLibraryAccessors = new MicrometerTracingLibraryAccessors(owner);

        public MicrometerLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>micrometer.tracing</b>
         */
        public MicrometerTracingLibraryAccessors getTracing() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class MicrometerTracingLibraryAccessors extends SubDependencyFactory {
        private final MicrometerTracingBridgeLibraryAccessors laccForMicrometerTracingBridgeLibraryAccessors = new MicrometerTracingBridgeLibraryAccessors(owner);

        public MicrometerTracingLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>micrometer.tracing.bridge</b>
         */
        public MicrometerTracingBridgeLibraryAccessors getBridge() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class MicrometerTracingBridgeLibraryAccessors extends SubDependencyFactory {

        public MicrometerTracingBridgeLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>otel</b> with <b>io.micrometer:micrometer-tracing-bridge-otel</b> coordinates and
         * with version reference <b>micrometer</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getOtel() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class MysqlLibraryAccessors extends SubDependencyFactory {

        public MysqlLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>connector</b> with <b>com.mysql:mysql-connector-j</b> coordinates and
         * with version reference <b>mysql.connector</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getConnector() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class NimbusLibraryAccessors extends SubDependencyFactory {
        private final NimbusJoseLibraryAccessors laccForNimbusJoseLibraryAccessors = new NimbusJoseLibraryAccessors(owner);

        public NimbusLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>nimbus.jose</b>
         */
        public NimbusJoseLibraryAccessors getJose() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class NimbusJoseLibraryAccessors extends SubDependencyFactory {

        public NimbusJoseLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>jwt</b> with <b>com.nimbusds:nimbus-jose-jwt</b> coordinates and
         * with version reference <b>jose</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getJwt() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class OtelLibraryAccessors extends SubDependencyFactory {
        private final OtelExporterLibraryAccessors laccForOtelExporterLibraryAccessors = new OtelExporterLibraryAccessors(owner);
        private final OtelSemconvLibraryAccessors laccForOtelSemconvLibraryAccessors = new OtelSemconvLibraryAccessors(owner);

        public OtelLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>otel.exporter</b>
         */
        public OtelExporterLibraryAccessors getExporter() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>otel.semconv</b>
         */
        public OtelSemconvLibraryAccessors getSemconv() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class OtelExporterLibraryAccessors extends SubDependencyFactory {

        public OtelExporterLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>otlp</b> with <b>io.opentelemetry:opentelemetry-exporter-otlp</b> coordinates and
         * with version reference <b>otel</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getOtlp() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class OtelSemconvLibraryAccessors extends SubDependencyFactory {

        public OtelSemconvLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>incubating</b> with <b>io.opentelemetry.semconv:opentelemetry-semconv-incubating</b> coordinates and
         * with version <b>1.41.0-alpha</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getIncubating() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class Resilience4jLibraryAccessors extends SubDependencyFactory {
        private final Resilience4jSpringLibraryAccessors laccForResilience4jSpringLibraryAccessors = new Resilience4jSpringLibraryAccessors(owner);

        public Resilience4jLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>resilience4j.spring</b>
         */
        public Resilience4jSpringLibraryAccessors getSpring() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class Resilience4jSpringLibraryAccessors extends SubDependencyFactory {

        public Resilience4jSpringLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>boot3</b> with <b>io.github.resilience4j:resilience4j-spring-boot3</b> coordinates and
         * with version reference <b>resilience4j</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getBoot3() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringLibraryAccessors extends SubDependencyFactory {
        private final SpringAiLibraryAccessors laccForSpringAiLibraryAccessors = new SpringAiLibraryAccessors(owner);
        private final SpringBootLibraryAccessors laccForSpringBootLibraryAccessors = new SpringBootLibraryAccessors(owner);

        public SpringLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>spring.ai</b>
         */
        public SpringAiLibraryAccessors getAi() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>spring.boot</b>
         */
        public SpringBootLibraryAccessors getBoot() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringAiLibraryAccessors extends SubDependencyFactory {
        private final SpringAiAlibabaLibraryAccessors laccForSpringAiAlibabaLibraryAccessors = new SpringAiAlibabaLibraryAccessors(owner);

        public SpringAiLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>mcp</b> with <b>org.springframework.ai:spring-ai-mcp</b> coordinates and
         * with version reference <b>spring.ai</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getMcp() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>openai</b> with <b>org.springframework.ai:spring-ai-starter-model-openai</b> coordinates and
         * with version reference <b>spring.ai</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getOpenai() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>pgvector</b> with <b>org.springframework.ai:spring-ai-pgvector-store-spring-boot-starter</b> coordinates and
         * with version reference <b>spring.ai</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getPgvector() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>spring.ai.alibaba</b>
         */
        public SpringAiAlibabaLibraryAccessors getAlibaba() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringAiAlibabaLibraryAccessors extends SubDependencyFactory {

        public SpringAiAlibabaLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>graph</b> with <b>com.alibaba.cloud.ai:spring-ai-alibaba-graph-core</b> coordinates and
         * with version reference <b>spring.ai.alibaba</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getGraph() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringBootLibraryAccessors extends SubDependencyFactory {
        private final SpringBootConfigurationLibraryAccessors laccForSpringBootConfigurationLibraryAccessors = new SpringBootConfigurationLibraryAccessors(owner);
        private final SpringBootStarterLibraryAccessors laccForSpringBootStarterLibraryAccessors = new SpringBootStarterLibraryAccessors(owner);

        public SpringBootLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>spring.boot.configuration</b>
         */
        public SpringBootConfigurationLibraryAccessors getConfiguration() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>spring.boot.starter</b>
         */
        public SpringBootStarterLibraryAccessors getStarter() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringBootConfigurationLibraryAccessors extends SubDependencyFactory {

        public SpringBootConfigurationLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>processor</b> with <b>org.springframework.boot:spring-boot-configuration-processor</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getProcessor() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringBootStarterLibraryAccessors extends SubDependencyFactory {
        private final SpringBootStarterDataLibraryAccessors laccForSpringBootStarterDataLibraryAccessors = new SpringBootStarterDataLibraryAccessors(owner);

        public SpringBootStarterLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>actuator</b> with <b>org.springframework.boot:spring-boot-starter-actuator</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getActuator() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>cache</b> with <b>org.springframework.boot:spring-boot-starter-cache</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getCache() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>jdbc</b> with <b>org.springframework.boot:spring-boot-starter-jdbc</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getJdbc() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>security</b> with <b>org.springframework.boot:spring-boot-starter-security</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getSecurity() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>test</b> with <b>org.springframework.boot:spring-boot-starter-test</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getTest() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>validation</b> with <b>org.springframework.boot:spring-boot-starter-validation</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getValidation() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>web</b> with <b>org.springframework.boot:spring-boot-starter-web</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getWeb() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Dependency provider for <b>webflux</b> with <b>org.springframework.boot:spring-boot-starter-webflux</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getWebflux() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>spring.boot.starter.data</b>
         */
        public SpringBootStarterDataLibraryAccessors getData() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringBootStarterDataLibraryAccessors extends SubDependencyFactory {
        private final SpringBootStarterDataRedisLibraryAccessors laccForSpringBootStarterDataRedisLibraryAccessors = new SpringBootStarterDataRedisLibraryAccessors(owner);

        public SpringBootStarterDataLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Group of libraries at <b>spring.boot.starter.data.redis</b>
         */
        public SpringBootStarterDataRedisLibraryAccessors getRedis() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringBootStarterDataRedisLibraryAccessors extends SubDependencyFactory {

        public SpringBootStarterDataRedisLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>reactive</b> with <b>org.springframework.boot:spring-boot-starter-data-redis-reactive</b> coordinates and
         * with <b>no version specified</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getReactive() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class SpringdocLibraryAccessors extends SubDependencyFactory {

        public SpringdocLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>openapi</b> with <b>org.springdoc:springdoc-openapi-starter-webflux-ui</b> coordinates and
         * with version reference <b>springdoc</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getOpenapi() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class TestcontainersLibraryAccessors extends SubDependencyFactory {
        private final TestcontainersJunitLibraryAccessors laccForTestcontainersJunitLibraryAccessors = new TestcontainersJunitLibraryAccessors(owner);

        public TestcontainersLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>postgresql</b> with <b>org.testcontainers:postgresql</b> coordinates and
         * with version reference <b>testcontainers</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getPostgresql() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

        /**
         * Group of libraries at <b>testcontainers.junit</b>
         */
        public TestcontainersJunitLibraryAccessors getJunit() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class TestcontainersJunitLibraryAccessors extends SubDependencyFactory {

        public TestcontainersJunitLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>jupiter</b> with <b>org.testcontainers:junit-jupiter</b> coordinates and
         * with version reference <b>testcontainers</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getJupiter() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class WiremockLibraryAccessors extends SubDependencyFactory {

        public WiremockLibraryAccessors(AbstractExternalDependencyFactory owner) { super(owner); }

        /**
         * Dependency provider for <b>jetty12</b> with <b>org.wiremock:wiremock-standalone</b> coordinates and
         * with version reference <b>wiremock</b>
         * <p>
         * This dependency was declared in catalog libs.versions.toml
         */
        public Provider<MinimalExternalModuleDependency> getJetty12() {
            throw new GradleException("Accessing libraries or bundles from version catalogs in the plugins block is not allowed. Only use versions or plugins from catalogs in the plugins block.");
        }

    }

    public static class VersionAccessors extends VersionFactory  {

        private final ApacheVersionAccessors vaccForApacheVersionAccessors = new ApacheVersionAccessors(providers, config);
        private final JsonVersionAccessors vaccForJsonVersionAccessors = new JsonVersionAccessors(providers, config);
        private final MysqlVersionAccessors vaccForMysqlVersionAccessors = new MysqlVersionAccessors(providers, config);
        private final SpringVersionAccessors vaccForSpringVersionAccessors = new SpringVersionAccessors(providers, config);
        public VersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>assertj</b> with value <b>3.26.3</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getAssertj() { return getVersion("assertj"); }

        /**
         * Version alias <b>awaitility</b> with value <b>4.2.2</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getAwaitility() { return getVersion("awaitility"); }

        /**
         * Version alias <b>bouncycastle</b> with value <b>1.80</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getBouncycastle() { return getVersion("bouncycastle"); }

        /**
         * Version alias <b>bucket4j</b> with value <b>8.10.1</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getBucket4j() { return getVersion("bucket4j"); }

        /**
         * Version alias <b>caffeine</b> with value <b>3.1.8</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getCaffeine() { return getVersion("caffeine"); }

        /**
         * Version alias <b>guava</b> with value <b>33.3.1-jre</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getGuava() { return getVersion("guava"); }

        /**
         * Version alias <b>hikari</b> with value <b>5.1.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getHikari() { return getVersion("hikari"); }

        /**
         * Version alias <b>jackson</b> with value <b>2.17.2</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJackson() { return getVersion("jackson"); }

        /**
         * Version alias <b>java</b> with value <b>21</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJava() { return getVersion("java"); }

        /**
         * Version alias <b>jcommander</b> with value <b>1.83</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJcommander() { return getVersion("jcommander"); }

        /**
         * Version alias <b>jose</b> with value <b>9.37.3</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJose() { return getVersion("jose"); }

        /**
         * Version alias <b>jsoup</b> with value <b>1.18.1</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJsoup() { return getVersion("jsoup"); }

        /**
         * Version alias <b>jtokkit</b> with value <b>1.1.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJtokkit() { return getVersion("jtokkit"); }

        /**
         * Version alias <b>junit</b> with value <b>5.11.3</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getJunit() { return getVersion("junit"); }

        /**
         * Version alias <b>lombok</b> with value <b>1.18.38</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getLombok() { return getVersion("lombok"); }

        /**
         * Version alias <b>mapstruct</b> with value <b>1.6.2</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getMapstruct() { return getVersion("mapstruct"); }

        /**
         * Version alias <b>micrometer</b> with value <b>1.13.3</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getMicrometer() { return getVersion("micrometer"); }

        /**
         * Version alias <b>okhttp</b> with value <b>4.12.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getOkhttp() { return getVersion("okhttp"); }

        /**
         * Version alias <b>otel</b> with value <b>1.41.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getOtel() { return getVersion("otel"); }

        /**
         * Version alias <b>pgvector</b> with value <b>0.1.6</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getPgvector() { return getVersion("pgvector"); }

        /**
         * Version alias <b>resilience4j</b> with value <b>2.2.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getResilience4j() { return getVersion("resilience4j"); }

        /**
         * Version alias <b>spotless</b> with value <b>6.25.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getSpotless() { return getVersion("spotless"); }

        /**
         * Version alias <b>springdoc</b> with value <b>2.6.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getSpringdoc() { return getVersion("springdoc"); }

        /**
         * Version alias <b>testcontainers</b> with value <b>1.20.2</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getTestcontainers() { return getVersion("testcontainers"); }

        /**
         * Version alias <b>wiremock</b> with value <b>3.9.2</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getWiremock() { return getVersion("wiremock"); }

        /**
         * Group of versions at <b>versions.apache</b>
         */
        public ApacheVersionAccessors getApache() {
            return vaccForApacheVersionAccessors;
        }

        /**
         * Group of versions at <b>versions.json</b>
         */
        public JsonVersionAccessors getJson() {
            return vaccForJsonVersionAccessors;
        }

        /**
         * Group of versions at <b>versions.mysql</b>
         */
        public MysqlVersionAccessors getMysql() {
            return vaccForMysqlVersionAccessors;
        }

        /**
         * Group of versions at <b>versions.spring</b>
         */
        public SpringVersionAccessors getSpring() {
            return vaccForSpringVersionAccessors;
        }

    }

    public static class ApacheVersionAccessors extends VersionFactory  {

        private final ApacheCommonsVersionAccessors vaccForApacheCommonsVersionAccessors = new ApacheCommonsVersionAccessors(providers, config);
        public ApacheVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Group of versions at <b>versions.apache.commons</b>
         */
        public ApacheCommonsVersionAccessors getCommons() {
            return vaccForApacheCommonsVersionAccessors;
        }

    }

    public static class ApacheCommonsVersionAccessors extends VersionFactory  {

        public ApacheCommonsVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>apache.commons.compress</b> with value <b>1.27.1</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getCompress() { return getVersion("apache.commons.compress"); }

        /**
         * Version alias <b>apache.commons.lang</b> with value <b>3.17.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getLang() { return getVersion("apache.commons.lang"); }

    }

    public static class JsonVersionAccessors extends VersionFactory  {

        public JsonVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>json.schema</b> with value <b>1.5.1</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getSchema() { return getVersion("json.schema"); }

    }

    public static class MysqlVersionAccessors extends VersionFactory  {

        public MysqlVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>mysql.connector</b> with value <b>8.3.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getConnector() { return getVersion("mysql.connector"); }

    }

    public static class SpringVersionAccessors extends VersionFactory  {

        private final SpringAiVersionAccessors vaccForSpringAiVersionAccessors = new SpringAiVersionAccessors(providers, config);
        private final SpringDepVersionAccessors vaccForSpringDepVersionAccessors = new SpringDepVersionAccessors(providers, config);
        public SpringVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>spring.boot</b> with value <b>3.3.4</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getBoot() { return getVersion("spring.boot"); }

        /**
         * Version alias <b>spring.cloud</b> with value <b>2023.0.3</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getCloud() { return getVersion("spring.cloud"); }

        /**
         * Group of versions at <b>versions.spring.ai</b>
         */
        public SpringAiVersionAccessors getAi() {
            return vaccForSpringAiVersionAccessors;
        }

        /**
         * Group of versions at <b>versions.spring.dep</b>
         */
        public SpringDepVersionAccessors getDep() {
            return vaccForSpringDepVersionAccessors;
        }

    }

    public static class SpringAiVersionAccessors extends VersionFactory  implements VersionNotationSupplier {

        public SpringAiVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>spring.ai</b> with value <b>1.1.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> asProvider() { return getVersion("spring.ai"); }

        /**
         * Version alias <b>spring.ai.alibaba</b> with value <b>1.1.0.0</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getAlibaba() { return getVersion("spring.ai.alibaba"); }

    }

    public static class SpringDepVersionAccessors extends VersionFactory  {

        public SpringDepVersionAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Version alias <b>spring.dep.mgmt</b> with value <b>1.1.6</b>
         * <p>
         * If the version is a rich version and cannot be represented as a
         * single version string, an empty string is returned.
         * <p>
         * This version was declared in catalog libs.versions.toml
         */
        public Provider<String> getMgmt() { return getVersion("spring.dep.mgmt"); }

    }

    public static class BundleAccessors extends BundleFactory {

        public BundleAccessors(ObjectFactory objects, ProviderFactory providers, DefaultVersionCatalog config, AttributesFactory attributesFactory, CapabilityNotationParser capabilityNotationParser) { super(objects, providers, config, attributesFactory, capabilityNotationParser); }

    }

    public static class PluginAccessors extends PluginFactory {
        private final SpringPluginAccessors paccForSpringPluginAccessors = new SpringPluginAccessors(providers, config);

        public PluginAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Plugin provider for <b>spotless</b> with plugin id <b>com.diffplug.spotless</b> and
         * with version reference <b>spotless</b>
         * <p>
         * This plugin was declared in catalog libs.versions.toml
         */
        public Provider<PluginDependency> getSpotless() { return createPlugin("spotless"); }

        /**
         * Group of plugins at <b>plugins.spring</b>
         */
        public SpringPluginAccessors getSpring() {
            return paccForSpringPluginAccessors;
        }

    }

    public static class SpringPluginAccessors extends PluginFactory {
        private final SpringDependencyPluginAccessors paccForSpringDependencyPluginAccessors = new SpringDependencyPluginAccessors(providers, config);

        public SpringPluginAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Plugin provider for <b>spring.boot</b> with plugin id <b>org.springframework.boot</b> and
         * with version reference <b>spring.boot</b>
         * <p>
         * This plugin was declared in catalog libs.versions.toml
         */
        public Provider<PluginDependency> getBoot() { return createPlugin("spring.boot"); }

        /**
         * Group of plugins at <b>plugins.spring.dependency</b>
         */
        public SpringDependencyPluginAccessors getDependency() {
            return paccForSpringDependencyPluginAccessors;
        }

    }

    public static class SpringDependencyPluginAccessors extends PluginFactory {

        public SpringDependencyPluginAccessors(ProviderFactory providers, DefaultVersionCatalog config) { super(providers, config); }

        /**
         * Plugin provider for <b>spring.dependency.mgmt</b> with plugin id <b>io.spring.dependency-management</b> and
         * with version reference <b>spring.dep.mgmt</b>
         * <p>
         * This plugin was declared in catalog libs.versions.toml
         */
        public Provider<PluginDependency> getMgmt() { return createPlugin("spring.dependency.mgmt"); }

    }

}
