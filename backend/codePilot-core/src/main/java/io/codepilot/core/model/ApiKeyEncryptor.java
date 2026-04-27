package io.codepilot.core.model;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * AES-256-GCM encryptor for API keys stored in the database.
 *
 * <p>The encryption key is provided via {@code CODEPILOT_KMS_KEY} env variable
 * (base64-encoded 256-bit key). If not set, a warning is logged and a
 * deterministic key is used (dev only — MUST be set in production).
 */
@Component
public class ApiKeyEncryptor {

  private static final Logger LOG = LoggerFactory.getLogger(ApiKeyEncryptor.class);
  private static final String ALGO = "AES/GCM/NoPadding";
  private static final int GCM_IV_LEN = 12;
  private static final int GCM_TAG_LEN = 128;

  private final SecretKeySpec key;
  private final SecureRandom random = new SecureRandom();

  public ApiKeyEncryptor(
      @Value("${codepilot.kms-key:${CODEPILOT_KMS_KEY:}}") String kmsKeyBase64) {
    if (kmsKeyBase64 == null || kmsKeyBase64.isBlank()) {
      LOG.warn("CODEPILOT_KMS_KEY not set — using dev-only encryption key. "
          + "MUST set in production!");
      // Dev fallback: a fixed 256-bit key (NOT secure)
      byte[] devKey = new byte[32];
      System.arraycopy("codePilot-dev-key-32bytes!!".getBytes(StandardCharsets.UTF_8), 0, devKey, 0, 32);
      this.key = new SecretKeySpec(devKey, "AES");
    } else {
      byte[] decoded = Base64.getDecoder().decode(kmsKeyBase64);
      if (decoded.length != 32) {
        throw new IllegalArgumentException("KMS key must be 256 bits (32 bytes)");
      }
      this.key = new SecretKeySpec(decoded, "AES");
    }
  }

  /** Encrypts plaintext and returns base64(iv + ciphertext). */
  public String encrypt(String plaintext) {
    try {
      byte[] iv = new byte[GCM_IV_LEN];
      random.nextBytes(iv);
      Cipher cipher = Cipher.getInstance(ALGO);
      cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LEN, iv));
      byte[] cipherText = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
      byte[] combined = new byte[iv.length + cipherText.length];
      System.arraycopy(iv, 0, combined, 0, iv.length);
      System.arraycopy(cipherText, 0, combined, iv.length, cipherText.length);
      return Base64.getEncoder().encodeToString(combined);
    } catch (Exception e) {
      throw new RuntimeException("Failed to encrypt API key", e);
    }
  }

  /** Decrypts base64(iv + ciphertext) back to plaintext. */
  public String decrypt(String encrypted) {
    try {
      byte[] combined = Base64.getDecoder().decode(encrypted);
      byte[] iv = new byte[GCM_IV_LEN];
      System.arraycopy(combined, 0, iv, 0, GCM_IV_LEN);
      byte[] cipherText = new byte[combined.length - GCM_IV_LEN];
      System.arraycopy(combined, GCM_IV_LEN, cipherText, 0, cipherText.length);
      Cipher cipher = Cipher.getInstance(ALGO);
      cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LEN, iv));
      return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
    } catch (Exception e) {
      throw new RuntimeException("Failed to decrypt API key", e);
    }
  }

  /** Returns a masked version of the API key: "***" + last 4 chars. */
  public static String mask(String apiKey) {
    if (apiKey == null || apiKey.length() <= 4) return "***";
    return "***" + apiKey.substring(apiKey.length() - 4);
  }
}