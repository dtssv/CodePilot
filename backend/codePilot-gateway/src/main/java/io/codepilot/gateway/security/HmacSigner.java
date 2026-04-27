package io.codepilot.gateway.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.commons.lang3.StringUtils;

/** HMAC-SHA256 helper aligned with the signature spec in docs/05-接口文档.md §0. */
public final class HmacSigner {

  private static final String ALGO = "HmacSHA256";
  private static final HexFormat HEX = HexFormat.of();

  private final byte[] key;

  public HmacSigner(String secret) {
    this.key = secret.getBytes(StandardCharsets.UTF_8);
  }

  /**
   * Computes {@code HEX(HmacSHA256(key, body || '\n' || ts || '\n' || nonce))}.
   *
   * <p>Body may be empty for GET / DELETE requests; the separators keep the signature
   * non-ambiguous even when one of the inputs is empty.
   */
  public String sign(String body, String ts, String nonce) {
    try {
      Mac mac = Mac.getInstance(ALGO);
      mac.init(new SecretKeySpec(key, ALGO));
      mac.update(StringUtils.defaultString(body).getBytes(StandardCharsets.UTF_8));
      mac.update((byte) '\n');
      mac.update(ts.getBytes(StandardCharsets.UTF_8));
      mac.update((byte) '\n');
      mac.update(nonce.getBytes(StandardCharsets.UTF_8));
      return HEX.formatHex(mac.doFinal());
    } catch (Exception e) {
      // This is an internal crypto error (never a user-facing message).
      throw new IllegalStateException("HMAC computation failed", e);
    }
  }

  public boolean verify(String body, String ts, String nonce, String expected) {
    String actual = sign(body, ts, nonce);
    return MessageDigest.isEqual(
        actual.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8));
  }
}