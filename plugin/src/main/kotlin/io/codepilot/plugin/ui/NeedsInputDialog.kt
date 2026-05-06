package io.codepilot.plugin.ui

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import javax.swing.AbstractButton
import javax.swing.BoxLayout
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JRadioButton

/**
 * Renders a `needs_input` payload as a stack of question cards. Returns the user's answers as an
 * already-shaped list of `{questionId, optionId?, freeform?}` maps suitable for the next
 * `/v1/conversation/run` request.
 */
class NeedsInputDialog(
    project: Project?,
    private val payload: JsonNode,
) : DialogWrapper(project, true) {

    private val perQuestionState = mutableListOf<Question>()
    private val freeformField = JBTextField()
    private var freeformParsed: List<Map<String, Any?>> = emptyList()

    init {
        title = payload.path("title").asText("CodePilot needs your input")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val outer = JPanel()
        outer.layout = BoxLayout(outer, BoxLayout.Y_AXIS)
        outer.border = JBUI.Borders.empty(8)

        val reason = payload.path("reason").asText("")
        if (reason.isNotBlank()) outer.add(JBLabel("<html>$reason</html>"))

        val questions = payload.path("questions")
        if (questions.isArray) {
            questions.forEach { outer.add(buildQuestion(it)) }
        }

        // free-form fall-through — applies to all questions when filled.
        outer.add(JBLabel("Or type 'q1: a; q2: 600' or any free text:"))
        outer.add(freeformField)

        val notes = payload.path("notesForUser")
        if (notes.isArray) {
            outer.add(JBLabel(" "))
            notes.forEach { outer.add(JBLabel("• " + it.asText(""))) }
        }
        return outer
    }

    private fun buildQuestion(q: JsonNode): JComponent {
        val box = panel {
            val title = "Q${q.path("index").asInt(perQuestionState.size + 1)}: ${q.path("prompt").asText("")}"
            row { label(title) }
            val state = Question(q.path("id").asText(""), null, null)
            perQuestionState.add(state)
            val kind = q.path("kind").asText("single-choice")
            val options = q.path("options")
            if (options.isArray && (kind == "single-choice" || kind == "yes-no")) {
                val group = ButtonGroup()
                val def = q.path("defaultOptionId").asText(null)
                options.forEach { opt ->
                    val id = opt.path("id").asText()
                    val label = opt.path("label").asText(id) +
                        if (opt.path("impact").asText().isNotBlank())
                            " [impact: ${opt.path("impact").asText()}]"
                        else ""
                    row {
                        radioButton(label).apply {
                            component.isSelected = id == def
                            if (component.isSelected) state.optionId = id
                            component.actionListeners // no-op
                            component.addActionListener { state.optionId = id }
                            group.add(component)
                        }
                    }
                }
            } else {
                // freeform / multi-choice fall back to a textarea per question
                row {
                    val ta = JBTextArea(2, 40)
                    cell(ta).component.let { area ->
                        area.lineWrap = true
                        area.addCaretListener { state.freeform = area.text }
                    }
                }
            }
        }
        return box
    }

    override fun doOKAction() {
        val raw = freeformField.text.trim()
        freeformParsed = if (raw.isEmpty()) emptyList() else parseFreeform(raw)
        super.doOKAction()
    }

    fun answers(): List<Map<String, Any?>> {
        val out = mutableListOf<Map<String, Any?>>()
        perQuestionState.forEach { q ->
            if (q.optionId != null || !q.freeform.isNullOrBlank()) {
                val m = mutableMapOf<String, Any?>("questionId" to q.id)
                q.optionId?.let { m["optionId"] = it }
                q.freeform?.let { m["freeform"] = it }
                out.add(m)
            }
        }
        // Apply free-form parsed entries on top, possibly overriding earlier picks.
        freeformParsed.forEach { incoming ->
            val qid = incoming["questionId"] as? String
            if (qid != null) out.removeAll { it["questionId"] == qid }
            out.add(incoming)
        }
        return out
    }

    private fun parseFreeform(raw: String): List<Map<String, Any?>> {
        val parts = raw.split(';', '\n').map { it.trim() }.filter { it.isNotEmpty() }
        val structured = Regex("^\\s*q?(\\d+)\\s*[:：\\-\\s]\\s*([\\S].*)$")
        val byIndex = perQuestionState.withIndex().associate { (i, q) -> (i + 1) to q.id }
        val out = mutableListOf<Map<String, Any?>>()
        parts.forEach { part ->
            val m = structured.matchEntire(part)
            if (m != null) {
                val idx = m.groupValues[1].toIntOrNull()
                val ans = m.groupValues[2].trim()
                val qid = idx?.let { byIndex[it] }
                val entry = mutableMapOf<String, Any?>()
                if (qid != null) entry["questionId"] = qid
                // If the answer matches an option id of the question, prefer optionId.
                val optionId = matchOption(qid, ans)
                if (optionId != null) entry["optionId"] = optionId else entry["freeform"] = ans
                out.add(entry)
            } else {
                out.add(mapOf("freeform" to part))
            }
        }
        return out
    }

    private fun matchOption(questionId: String?, candidate: String): String? {
        if (questionId == null) return null
        val q = payload.path("questions").firstOrNull { it.path("id").asText() == questionId } ?: return null
        val options = q.path("options")
        if (!options.isArray) return null
        return options.firstOrNull { it.path("id").asText().equals(candidate, ignoreCase = true) }?.path("id")?.asText()
    }

    private data class Question(
        val id: String,
        var optionId: String?,
        var freeform: String?,
    )
}