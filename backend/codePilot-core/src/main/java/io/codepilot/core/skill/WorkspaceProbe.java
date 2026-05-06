package io.codepilot.core.skill;

import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Lightweight inference of language / framework / action signals from a {@link
 * ConversationRunRequest}. We avoid heavy detection in M6/R1: probes only inspect the request
 * (contexts.refs, pinned, taskLedger.notes, input). Plugins that already know the answer can
 * carry it via taskLedger.notes (e.g. "Java 17 + Spring Boot").
 */
@Component
public class WorkspaceProbe {

  /** Result of probing; never null fields, lists are immutable. */
  public record Probe(
      ConversationMode mode,
      String action,
      Set<String> languages,
      Set<String> frameworks,
      Set<String> filePaths,
      Set<String> keywords) {}

  public Probe probe(ConversationRunRequest req) {
    Set<String> languages = new LinkedHashSet<>();
    Set<String> frameworks = new LinkedHashSet<>();
    Set<String> filePaths = new LinkedHashSet<>();
    Set<String> keywords = new LinkedHashSet<>();

    if (req.contexts() != null) {
      collectFromRefs(req.contexts().refs(), languages, frameworks, filePaths);
      collectFromPinned(req.contexts().pinned(), languages, frameworks, filePaths);
    }
    if (req.taskLedger() != null && req.taskLedger().notes() != null) {
      req.taskLedger().notes().forEach(n -> mineNote(n, languages, frameworks, keywords));
    }
    String input = req.input();
    if (input != null) {
      mineNote(input, languages, frameworks, keywords);
    }

    String action = detectAction(req);
    return new Probe(
        req.mode() == null ? ConversationMode.CHAT : req.mode(),
        action,
        Collections.unmodifiableSet(languages),
        Collections.unmodifiableSet(frameworks),
        Collections.unmodifiableSet(filePaths),
        Collections.unmodifiableSet(keywords));
  }

  // ----------------- helpers -----------------

  private void collectFromRefs(
      java.util.List<ConversationRunRequest.Contexts.Ref> refs,
      Set<String> languages,
      Set<String> frameworks,
      Set<String> filePaths) {
    if (refs == null) return;
    for (var ref : refs) {
      if (ref.path() != null) {
        filePaths.add(ref.path());
        addLanguageFromPath(ref.path(), languages, frameworks);
      }
    }
  }

  private void collectFromPinned(
      java.util.List<ConversationRunRequest.Contexts.PinnedItem> pinned,
      Set<String> languages,
      Set<String> frameworks,
      Set<String> filePaths) {
    if (pinned == null) return;
    for (var p : pinned) {
      if (p.path() != null) {
        filePaths.add(p.path());
        addLanguageFromPath(p.path(), languages, frameworks);
      }
    }
  }

  /** Encodes a tiny extension/file-name → language map; expand as needed. */
  private void addLanguageFromPath(String path, Set<String> languages, Set<String> frameworks) {
    String lower = path.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".java")) languages.add("java");
    else if (lower.endsWith(".kt") || lower.endsWith(".kts")) languages.add("kotlin");
    else if (lower.endsWith(".scala") || lower.endsWith(".sbt")) languages.add("scala");
    else if (lower.endsWith(".py") || lower.endsWith(".pyi")) languages.add("python");
    else if (lower.endsWith(".go")) languages.add("go");
    else if (lower.endsWith(".rs")) languages.add("rust");
    else if (lower.endsWith(".ts") || lower.endsWith(".tsx")) languages.add("typescript");
    else if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) languages.add("javascript");
    else if (lower.endsWith(".vue")) languages.add("vue");
    else if (lower.endsWith(".rb")) languages.add("ruby");
    else if (lower.endsWith(".php")) languages.add("php");
    else if (lower.endsWith(".cs")) languages.add("csharp");
    else if (lower.endsWith(".sql")) languages.add("sql");
    else if (lower.endsWith(".sh") || lower.endsWith(".bash")) languages.add("shell");
    else if (lower.endsWith(".ps1")) languages.add("powershell");

    // Build/config files imply frameworks.
    if (lower.endsWith("pom.xml") || lower.endsWith("build.gradle") || lower.endsWith("build.gradle.kts")) {
      languages.add("java");
      frameworks.add("gradle-or-maven");
    }
    if (lower.endsWith("package.json") || lower.endsWith("tsconfig.json")) frameworks.add("node");
    if (lower.endsWith("pyproject.toml") || lower.endsWith("requirements.txt")) frameworks.add("python");
    if (lower.endsWith("go.mod")) frameworks.add("go-modules");
    if (lower.endsWith("cargo.toml")) frameworks.add("cargo");
    if (lower.endsWith("dockerfile")) frameworks.add("docker");
  }

  /** Cheap regex-free notes mining (tolerates random log-style strings). */
  private void mineNote(String note, Set<String> languages, Set<String> frameworks, Set<String> keywords) {
    String s = note.toLowerCase(Locale.ROOT);
    if (s.contains("spring boot") || s.contains("springboot")) frameworks.add("spring-boot");
    if (s.contains("mybatis")) frameworks.add("mybatis");
    if (s.contains("react")) frameworks.add("react");
    if (s.contains("nextjs") || s.contains("next.js")) frameworks.add("nextjs");
    if (s.contains("vue")) { frameworks.add("vue"); languages.add("vue"); }
    if (s.contains("django")) frameworks.add("django");
    if (s.contains("fastapi")) frameworks.add("fastapi");
    if (s.contains("postgres") || s.contains("pgvector")) frameworks.add("postgres");
    if (s.contains("mysql")) frameworks.add("mysql");
    if (s.contains("redis")) frameworks.add("redis");
    if (s.contains("kubernetes") || s.contains("k8s")) frameworks.add("kubernetes");
    if (s.contains("docker")) frameworks.add("docker");
    if (s.contains("refactor")) keywords.add("refactor");
    if (s.contains("review")) keywords.add("review");
    if (s.contains("test") || s.contains("unittest")) keywords.add("gentest");
    if (s.contains("doc") || s.contains("documentation")) keywords.add("gendoc");
  }

  private String detectAction(ConversationRunRequest req) {
    if (req.input() == null) return "generic";
    String header = req.input().lines().findFirst().orElse("");
    int b = header.indexOf('[');
    int e = header.indexOf(']');
    if (b == 0 && e > 1) return header.substring(1, e).toLowerCase(Locale.ROOT);
    return "generic";
  }
}