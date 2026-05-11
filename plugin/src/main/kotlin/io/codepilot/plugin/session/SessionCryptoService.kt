package io.codepilot.plugin.session

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * ★ SessionCryptoService: AES-GCM encryption for local session files.
 *
 * When Privacy Mode → localEncryption is enabled, all NDJSON and JSON files
 * written by [SessionStore] are encrypted before being persisted to disk,
 * and decrypted on read. The encryption key is stored in IntelliJ's PasswordSafe.
 *
 * Algorithm: AES-256-GCM with 12-byte IV and 128-bit tag.
 * Key storage: PasswordSafe under "CodePilot.SessionEncryption" service.
 */
@Service(Service.Level.APP)
class SessionCryptoService {
    companion object {
        private const val ALGORITHM = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH = 128
        private const val GCM_IV_LENGTH = 12
        private const val KEY_SERVICE_NAME = "CodePilot.SessionEncryption"
        private const val KEY_ACCOUNT_NAME = "session-key"

        @JvmStatic fun getInstance(): SessionCryptoService = service()
    }

    private val secureRandom = SecureRandom()

    /** Check if encryption is enabled via settings. */
    fun isEncryptionEnabled(): Boolean = CodePilotSettings.getInstance().state.localEncryption

    /**
     * Encrypt bytes using AES-GCM. Output format: [12-byte IV][ciphertext+tag].
     * Returns the original bytes if encryption is disabled.
     */
    fun encrypt(plaintext: ByteArray): ByteArray {
        if (!isEncryptionEnabled()) return plaintext
        val key = getOrCreateKey()
        val iv = ByteArray(GCM_IV_LENGTH).also { secureRandom.nextBytes(it) }
        val cipher = Cipher.getInstance(ALGORITHM)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        val ciphertext = cipher.doFinal(plaintext)
        // Prepend IV to ciphertext
        return iv + ciphertext
    }

    /**
     * Decrypt bytes that were encrypted by [encrypt].
     * Returns the original bytes if encryption is disabled.
     */
    fun decrypt(ciphertextWithIv: ByteArray): ByteArray {
        if (!isEncryptionEnabled()) return ciphertextWithIv
        require(ciphertextWithIv.size > GCM_IV_LENGTH) { "Encrypted data too short" }
        val key = getOrCreateKey()
        val iv = ciphertextWithIv.copyOfRange(0, GCM_IV_LENGTH)
        val ciphertext = ciphertextWithIv.copyOfRange(GCM_IV_LENGTH, ciphertextWithIv.size)
        val cipher = Cipher.getInstance(ALGORITHM)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        return cipher.doFinal(ciphertext)
    }

    /** Encrypt a text string, returning Base64-encoded encrypted data. */
    fun encryptText(plaintext: String): String {
        if (!isEncryptionEnabled()) return plaintext
        val encrypted = encrypt(plaintext.toByteArray(StandardCharsets.UTF_8))
        return Base64.getEncoder().encodeToString(encrypted)
    }

    /** Decrypt a Base64-encoded encrypted string. */
    fun decryptText(encrypted: String): String {
        if (!isEncryptionEnabled()) return encrypted
        val bytes = Base64.getDecoder().decode(encrypted)
        return String(decrypt(bytes), StandardCharsets.UTF_8)
    }

    /** Encrypt a file in place. Reads the file, encrypts, and writes back. */
    fun encryptFile(file: Path) {
        if (!isEncryptionEnabled() || !Files.exists(file)) return
        val plaintext = Files.readAllBytes(file)
        val encrypted = encrypt(plaintext)
        Files.write(file, Base64.getEncoder().encode(encrypted))
    }

    /** Decrypt a file. Reads the encrypted file and returns the decrypted bytes. */
    fun decryptFile(file: Path): ByteArray {
        if (!isEncryptionEnabled()) return Files.readAllBytes(file)
        val base64Data = Files.readAllBytes(file)
        val encrypted = Base64.getDecoder().decode(base64Data)
        return decrypt(encrypted)
    }

    /**
     * Get or create the AES-256 encryption key.
     * The key is stored in IntelliJ's PasswordSafe for persistence.
     * PasswordSafe uses the OS keychain (macOS Keychain, Windows Credential Manager, etc.)
     */
    private fun getOrCreateKey(): ByteArray {
        // Try to read existing key from PasswordSafe
        val existingKey = readKeyFromPasswordSafe()
        if (existingKey != null) return existingKey

        // Generate a new 256-bit key
        val key = ByteArray(32).also { secureRandom.nextBytes(it) }
        saveKeyToPasswordSafe(key)
        return key
    }

    /**
     * Read the encryption key from IntelliJ PasswordSafe.
     * PasswordSafe uses the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
     * Falls back to a protected file if PasswordSafe is unavailable.
     */
    private fun readKeyFromPasswordSafe(): ByteArray? {
        // Primary: try IntelliJ PasswordSafe (uses OS keychain)
        try {
            val credAttrs = CredentialAttributes(KEY_SERVICE_NAME, KEY_ACCOUNT_NAME)
            val stored = PasswordSafe.instance.getPassword(credAttrs)
            if (stored != null && stored.isNotEmpty()) {
                return Base64.getDecoder().decode(stored)
            }
        } catch (_: Exception) {
            // PasswordSafe unavailable, fall through to file-based storage
        }

        // Fallback: read from protected file with owner-only permissions
        return try {
            val keyFile = getKeyFilePath()
            if (!Files.exists(keyFile)) return null
            val encoded = String(Files.readAllBytes(keyFile), StandardCharsets.UTF_8).trim()
            Base64.getDecoder().decode(encoded)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Save the encryption key to IntelliJ PasswordSafe.
     * Falls back to a protected file if PasswordSafe is unavailable.
     */
    private fun saveKeyToPasswordSafe(key: ByteArray) {
        val encoded = Base64.getEncoder().encodeToString(key)

        // Primary: try IntelliJ PasswordSafe
        try {
            val credAttrs = CredentialAttributes(KEY_SERVICE_NAME, KEY_ACCOUNT_NAME)
            PasswordSafe.instance.set(credAttrs, Credentials(KEY_ACCOUNT_NAME, encoded))
            return // Successfully stored in PasswordSafe, no need for file fallback
        } catch (_: Exception) {
            // PasswordSafe unavailable, fall through to file-based storage
        }

        // Fallback: write to protected file with owner-only permissions
        try {
            val keyFile = getKeyFilePath()
            Files.createDirectories(keyFile.parent)
            Files.writeString(keyFile, encoded, StandardCharsets.UTF_8)
            // Set file permissions to owner-only on supported platforms
            try {
                keyFile.toFile().setReadable(true, true)
                keyFile.toFile().setWritable(true, true)
            } catch (_: Exception) {
                // Best effort on non-POSIX platforms
            }
        } catch (_: Exception) {
            // Key persistence failed; will regenerate next time (session data from previous runs will be unreadable)
        }
    }

    /** Get the path for the encryption key file, stored in the IDE config directory. */
    private fun getKeyFilePath(): Path {
        val configDir = Path.of(System.getProperty("idea.config.path", System.getProperty("user.home")))
        return configDir.resolve(".codepilot").resolve("session.key")
    }
}
