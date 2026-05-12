package io.codepilot.core.context;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * LazyRefResolver — Resolves lazy @-references in context at prompt-assembly time.
 *
 * Instead of eagerly loading all @file/@symbol content into the context window,
 * references are stored as placeholders: {@code @file(path,range?,maxTokens?)}.
 * LazyRefResolver resolves them on-demand, respecting token budgets.
 *
 * Resolution order:
 * 1. Inline content already present → skip
 * 2. @file(path,range) → read file, apply range, truncate to maxTokens
 * 3. @symbol(fqName) → resolve via SymbolIndex, read definition
 * 4. @folder(path) → list directory, truncate
 * 5. Unresolvable → leave placeholder with error note
 */
public class LazyRefResolver {

    private static final Logger log = LoggerFactory.getLogger(LazyRefResolver.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Pattern: @file(path) or @file(path, L10-L30) or @file(path, L10-L30, 500) */
    private static final Pattern FILE_REF =
        Pattern.compile("@file\\(([^,)]+)(?:,\\s*L(\\d+)-L(\\d+))?(?:,\\s*(\\d+))?\\)");

    private static final Pattern SYMBOL_REF =
        Pattern.compile("@symbol\\(([^)]+)\\)");

    private static final Pattern FOLDER_REF =
        Pattern.compile("@folder\\(([^)]+)\\)");

    /** Cache: path → content (for repeated references in same session) */
    private final ConcurrentHashMap<String, String> contentCache = new ConcurrentHashMap<>();

    /** Token estimator for truncation */
    private final TokenEstimator tokenEstimator;

    public LazyRefResolver(TokenEstimator tokenEstimator) {
        this.tokenEstimator = tokenEstimator;
    }

    /**
     * Resolve all lazy references in a context string.
     * Returns the resolved string with placeholders replaced by actual content.
     */
    public String resolve(String context, int budgetTokens) {
        String result = context;
        int usedTokens = tokenEstimator.estimate(result);

        // Resolve @file references
        Matcher fileMatcher = FILE_REF.matcher(result);
        StringBuffer sb = new StringBuffer();
        while (fileMatcher.find() && usedTokens < budgetTokens) {
            String path = fileMatcher.group(1);
            int startLine = fileMatcher.group(2) != null ? Integer.parseInt(fileMatcher.group(2)) : 0;
            int endLine = fileMatcher.group(3) != null ? Integer.parseInt(fileMatcher.group(3)) : 0;
            int maxTokens = fileMatcher.group(4) != null ? Integer.parseInt(fileMatcher.group(4)) : 200;

            String resolved = resolveFileRef(path, startLine, endLine, Math.min(maxTokens, budgetTokens - usedTokens));
            usedTokens += tokenEstimator.estimate(resolved);
            fileMatcher.appendReplacement(sb, Matcher.quoteReplacement(resolved));
        }
        fileMatcher.appendTail(sb);
        result = sb.toString();

        // Resolve @symbol references
        Matcher symbolMatcher = SYMBOL_REF.matcher(result);
        sb = new StringBuffer();
        while (symbolMatcher.find() && usedTokens < budgetTokens) {
            String fqName = symbolMatcher.group(1);
            String resolved = resolveSymbolRef(fqName, budgetTokens - usedTokens);
            usedTokens += tokenEstimator.estimate(resolved);
            symbolMatcher.appendReplacement(sb, Matcher.quoteReplacement(resolved));
        }
        symbolMatcher.appendTail(sb);
        result = sb.toString();

        // Resolve @folder references
        Matcher folderMatcher = FOLDER_REF.matcher(result);
        sb = new StringBuffer();
        while (folderMatcher.find() && usedTokens < budgetTokens) {
            String path = folderMatcher.group(1);
            String resolved = resolveFolderRef(path, budgetTokens - usedTokens);
            usedTokens += tokenEstimator.estimate(resolved);
            folderMatcher.appendReplacement(sb, Matcher.quoteReplacement(resolved));
        }
        folderMatcher.appendTail(sb);

        return sb.toString();
    }

    private String resolveFileRef(String path, int startLine, int endLine, int maxTokens) {
        String cached = contentCache.get(path);
        if (cached != null) {
            return truncateToTokens(cached, maxTokens);
        }

        try {
            String content = Files.readString(Path.of(path));
            contentCache.put(path, content);

            // Apply line range if specified
            if (startLine > 0 || endLine > 0) {
                String[] lines = content.split("\n");
                int start = Math.max(0, startLine - 1);
                int end = endLine > 0 ? Math.min(lines.length, endLine) : lines.length;
                content = String.join("\n", Arrays.copyOfRange(lines, start, end));
            }

            return truncateToTokens(content, maxTokens);
        } catch (IOException e) {
            log.warn("LazyRefResolver: cannot read file {}", path);
            return "[@file(" + path + ") — error: file not found]";
        }
    }

    private String resolveSymbolRef(String fqName, int maxTokens) {
        // Symbol resolution requires the indexer — delegate to a placeholder for now
        // In production, this would call SymbolIndex.resolve(fqName) → definition text
        log.debug("LazyRefResolver: symbol resolution for {} (delegated to indexer)", fqName);
        return "[@symbol(" + fqName + ") — resolved by indexer at prompt time]";
    }

    private String resolveFolderRef(String path, int maxTokens) {
        try {
            String[] entries = Files.list(Path.of(path))
                .limit(100)
                .map(p -> p.getFileName().toString())
                .toArray(String[]::new);
            String listing = String.join("\n", entries);
            return truncateToTokens(listing, maxTokens);
        } catch (IOException e) {
            return "[@folder(" + path + ") — error: directory not found]";
        }
    }

    private String truncateToTokens(String text, int maxTokens) {
        int estimated = tokenEstimator.estimate(text);
        if (estimated <= maxTokens) return text;
        // Rough truncation: keep maxTokens * 3.5 chars (English heuristic)
        int maxChars = (int) (maxTokens * 3.5);
        return text.substring(0, Math.min(text.length(), maxChars)) + "\n... [truncated]";
    }

    /** Clear the content cache (call at session end). */
    public void clearCache() {
        contentCache.clear();
    }

    /** Simple token estimator interface for dependency injection. */
    public interface TokenEstimator {
        int estimate(String text);
    }
}