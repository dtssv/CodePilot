package io.codepilot.plugin.settings

/** Normalizes persisted locale to WebUI codes: {@code en} or {@code zh}. */
object LocaleHelper {
    const val EN = "en"
    const val ZH = "zh"

    fun normalize(raw: String?): String =
        when {
            raw.isNullOrBlank() -> EN
            raw.equals(ZH, ignoreCase = true) -> ZH
            raw.startsWith("zh", ignoreCase = true) -> ZH
            else -> EN
        }
}
