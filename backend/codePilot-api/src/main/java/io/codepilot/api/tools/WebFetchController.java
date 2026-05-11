package io.codepilot.api.tools;

import io.codepilot.common.api.ApiResponse;
import java.net.URI;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.HttpClient;

/**
 * Server-side web fetch proxy for @web references.
 * Fetches URL content on behalf of the plugin client to avoid CORS issues
 * and enforce security policies (allowlist, content-size limits).
 */
@RestController
@RequestMapping("/v1/tools")
public class WebFetchController {
    private static final Logger log = LoggerFactory.getLogger(WebFetchController.class);
    private static final int MAX_CONTENT_SIZE = 200 * 1024; // 200KB max
    private static final Duration FETCH_TIMEOUT = Duration.ofSeconds(15);

    private final WebClient webClient;

    public WebFetchController() {
        HttpClient httpClient = HttpClient.create()
                .responseTimeout(FETCH_TIMEOUT)
                .followRedirect(true);

        this.webClient = WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .codecs(configurer -> configurer
                        .defaultCodecs()
                        .maxInMemorySize(MAX_CONTENT_SIZE))
                .build();
    }

    /**
     * Fetch a URL and return cleaned text content.
     * @param url the URL to fetch (must be http or https)
     */
    @GetMapping("/web-fetch")
    public Mono<ApiResponse<WebFetchResult>> fetchUrl(@RequestParam String url) {
        // Validate URL scheme
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return Mono.just(ApiResponse.of(400, "Only http/https URLs are allowed"));
        }

        // Validate URL is not internal/private (SSRF protection)
        try {
            var uri = URI.create(url);
            var host = uri.getHost();
            if (host == null || isPrivateHost(host)) {
                return Mono.just(ApiResponse.of(403, "Private/internal URLs are not allowed"));
            }
        } catch (Exception e) {
            return Mono.just(ApiResponse.of(400, "Malformed URL: " + e.getMessage()));
        }

        log.info("[WebFetch] Fetching URL: {}", url);

        return webClient.get()
                .uri(url)
                .header(HttpHeaders.USER_AGENT, "CodePilot/1.0 (AI Coding Assistant)")
                .header(HttpHeaders.ACCEPT, "text/html,text/plain,application/json,text/markdown")
                .retrieve()
                .bodyToMono(String.class)
                .map(body -> {
                    String title = extractTitle(body);
                    String cleaned = cleanContent(body);
                    log.info("[WebFetch] Fetched {} ({} chars, title: {})", url, cleaned.length(), title);
                    return ApiResponse.ok(new WebFetchResult(title, url, cleaned));
                })
                .onErrorResume(e -> {
                    log.warn("[WebFetch] Failed to fetch {}: {}", url, e.getMessage());
                    return Mono.just(ApiResponse.of(502, "Failed to fetch URL: " + e.getMessage()));
                });
    }

    /** SSRF protection: block private/internal IP ranges. */
    private boolean isPrivateHost(String host) {
        return host.equals("localhost") || host.equals("127.0.0.1")
                || host.startsWith("10.") || host.startsWith("192.168.")
                || host.startsWith("172.16.") || host.startsWith("172.17.")
                || host.startsWith("172.18.") || host.startsWith("172.19.")
                || host.startsWith("172.2") || host.startsWith("172.3")
                || host.equals("0.0.0.0") || host.endsWith(".local")
                || host.endsWith(".internal");
    }

    /** Extract <title> from HTML content. */
    private String extractTitle(String body) {
        var match = java.util.regex.Pattern.compile("<title[^>]*>(.*?)</title>", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(body);
        return match.find() ? match.group(1).trim() : "";
    }

    /** Strip HTML tags, decode entities, normalize whitespace. */
    private String cleanContent(String body) {
        // Remove script and style blocks
        var cleaned = body.replaceAll("(?is)<script[^>]*>.*?</script>", "");
        cleaned = cleaned.replaceAll("(?is)<style[^>]*>.*?</style>", "");
        // Remove HTML tags
        cleaned = cleaned.replaceAll("<[^>]+>", " ");
        // Decode common HTML entities
        cleaned = cleaned.replace("&", "&").replace("<", "<").replace(">", ">")
                .replace("\"\"", "\"").replace("&#39;", "'").replace("&nbsp;", " ");
        // Normalize whitespace
        cleaned = cleaned.replaceAll("\\s+", " ").trim();
        // Limit size
        return cleaned.length() > 15000 ? cleaned.substring(0, 15000) + "..." : cleaned;
    }

    public record WebFetchResult(String title, String url, String content) {}
}