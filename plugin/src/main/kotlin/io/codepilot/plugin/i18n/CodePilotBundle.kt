package io.codepilot.plugin.i18n

import com.intellij.AbstractBundle
import org.jetbrains.annotations.PropertyKey

private const val BUNDLE = "messages.CodePilotBundle"

object CodePilotBundle : AbstractBundle(BUNDLE) {
    @JvmStatic
    fun message(
        @PropertyKey(resourceBundle = BUNDLE) key: String,
        vararg params: Any?,
    ): String = getMessage(key, *params)
}
