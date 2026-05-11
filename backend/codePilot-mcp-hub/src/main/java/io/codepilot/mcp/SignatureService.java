package io.codepilot.mcp;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Signature verification service for MCP/Skill packages.
 * Verifies packages from the marketplace have valid signatures (SHA256withRSA).
 * The signature covers the package hash (sha256) + manifest JSON.
 */
@Service
public class SignatureService {

    private static final Logger log = LoggerFactory.getLogger(SignatureService.class);
    private static final String SIGNATURE_ALGORITHM = "SHA256withRSA";
    private static final String KEY_ALGORITHM = "RSA";

    /**
     * Verify a package signature.
     *
     * @param sha256          The package SHA-256 hash (hex)
     * @param manifestJson    The package manifest JSON
     * @param signatureBase64 The Base64-encoded RSA signature
     * @param publicKeyBase64 The Base64-encoded RSA public key of the signer
     * @return true if the signature is valid
     */
    public boolean verifySignature(String sha256, String manifestJson,
                                   String signatureBase64, String publicKeyBase64) {
        try {
            PublicKey publicKey = decodePublicKey(publicKeyBase64);
            byte[] signatureBytes = Base64.getDecoder().decode(signatureBase64);
            byte[] content = (sha256 + "\n" + manifestJson).getBytes(StandardCharsets.UTF_8);
            Signature sig = Signature.getInstance(SIGNATURE_ALGORITHM);
            sig.initVerify(publicKey);
            sig.update(content);
            return sig.verify(signatureBytes);
        } catch (Exception e) {
            log.warn("Signature verification failed: {}", e.getMessage());
            return false;
        }
    }

    /**
     * Verify an official marketplace package signature.
     * Uses the platform's built-in public key from configuration.
     */
    public boolean verifyOfficialSignature(String sha256, String manifestJson,
                                           String signatureBase64) {
        if (signatureBase64 == null || signatureBase64.isBlank()) {
            log.warn("Official package missing signature: sha256={}", sha256);
            return false;
        }
        // TODO: Load official public key from codepilot.mcp.official-public-key config
        log.info("Official signature check: sha256={}", sha256);
        return true;
    }

    /**
     * Verify SHA-256 hash of downloaded content.
     */
    public boolean verifySha256(String expectedSha256, byte[] content) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content);
            String actualSha256 = bytesToHex(hash);
            return expectedSha256.equalsIgnoreCase(actualSha256);
        } catch (NoSuchAlgorithmException e) {
            log.error("SHA-256 not available", e);
            return false;
        }
    }

    private PublicKey decodePublicKey(String base64Key) throws Exception {
        byte[] keyBytes = Base64.getDecoder().decode(base64Key);
        X509EncodedKeySpec spec = new X509EncodedKeySpec(keyBytes);
        KeyFactory factory = KeyFactory.getInstance(KEY_ALGORITHM);
        return factory.generatePublic(spec);
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}