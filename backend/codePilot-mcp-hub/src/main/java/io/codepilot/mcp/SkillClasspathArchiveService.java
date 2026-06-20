package io.codepilot.mcp;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

/**
 * Builds a minimal Skill ZIP ({@code skill.yaml} only) from {@code codePilot-core} {@code
 * skills/*.yaml} on the classpath. Used when marketplace rows ship without {@code download_url}.
 */
@Service
public class SkillClasspathArchiveService {

  private final ConcurrentHashMap<String, byte[]> zipCache = new ConcurrentHashMap<>();

  /**
   * Slug {@code skill.lang.java} → classpath {@code skills/lang.java.yaml}; {@code
   * skill.action.refactor} → {@code skills/action.refactor.yaml}.
   */
  public static String resourcePathForSlug(String slug) {
    if (slug == null || !slug.startsWith("skill.")) {
      throw new IllegalArgumentException("Unsupported skill slug: " + slug);
    }
    return "skills/" + slug.substring("skill.".length()) + ".yaml";
  }

  public boolean hasClasspathYaml(String slug) {
    try {
      String path = resourcePathForSlug(slug);
      return new ClassPathResource(path).exists();
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  public byte[] zipBytes(String slug) {
    return zipCache.computeIfAbsent(slug, SkillClasspathArchiveService::buildZipUncached);
  }

  public String sha256Hex(byte[] bytes) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      return HexFormat.of().formatHex(md.digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static byte[] buildZipUncached(String slug) {
    String path = resourcePathForSlug(slug);
    ClassPathResource res = new ClassPathResource(path);
    if (!res.exists()) {
      throw new IllegalStateException("No bundled skill YAML for slug: " + slug);
    }
    byte[] yamlBytes;
    try (InputStream in = res.getInputStream()) {
      yamlBytes = in.readAllBytes();
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    try {
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      try (ZipOutputStream zos = new ZipOutputStream(bos)) {
        zos.putNextEntry(new ZipEntry("skill.yaml"));
        zos.write(yamlBytes);
        zos.closeEntry();
      }
      return bos.toByteArray();
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }
}
