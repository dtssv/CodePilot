package io.codepilot.plugin.transport

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Mirrors the backend's HMAC-SHA256 signature scheme: `HEX(HmacSHA256(key, body+\n+ts+\n+nonce))`. */
internal class HmacSigner(secret: String) {
    private val key = secret.toByteArray(Charsets.UTF_8)

    fun sign(body: String, ts: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        mac.update(body.toByteArray(Charsets.UTF_8))
        mac.update('\n'.code.toByte())
        mac.update(ts.toByteArray(Charsets.UTF_8))
        mac.update('\n'.code.toByte())
        mac.update(nonce.toByteArray(Charsets.UTF_8))
        return mac.doFinal().joinToString("") { "%02x".format(it) }
    }
}