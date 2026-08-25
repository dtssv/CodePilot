package io.codepilot.harness.harness

import io.codepilot.harness.context.Compactor
import io.codepilot.harness.context.ContextAssembler
import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.PermissionDecisionRecorded
import io.codepilot.harness.event.RunFinished
import io.codepilot.harness.event.RunStarted
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.hooks.HookRunner
import io.codepilot.harness.hooks.PreResult
import io.codepilot.harness.hooks.StopDirective
import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.model.ChatRequest
import io.codepilot.harness.model.StopKind
import io.codepilot.harness.model.StopReason
import io.codepilot.harness.model.TextDelta
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.perm.PermissionGate
import io.codepilot.harness.perm.Verdict
import io.codepilot.harness.session.EventSourcedSession
import io.codepilot.harness.tool.ToolCatalog
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.exec.ToolExecutor
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

data class HarnessConfig(
    val maxSteps: Int = 24,
    val maxToolOutputChars: Int = 16_000,
    val requestMaxTokens: Int? = null,
    val compactAfterChars: Int? = null,
)

sealed interface HarnessUiEvent {
    data class Delta(val text: String) : HarnessUiEvent
    data class PermissionNeeded(val callId: String, val tool: String, val reason: String) : HarnessUiEvent
    data class Persisted(val event: io.codepilot.harness.event.HarnessEvent) : HarnessUiEvent
}

fun interface ApprovalHandler {
    suspend fun decide(call: AssistantToolCall, reason: String): Verdict
}

/**
 * The deterministic agent loop. Target: <=300 lines, no branch explosion.
 *
 * loop {
 *   ctx = assembler.assemble(session)
 *   stream(model.chat(ctx)) -> collect TextDelta|AssistantToolCall|StopReason
 *   if end_turn && no pending calls: ask CompletionPolicy -> StopDirective
 *   for call in pendingCalls:
 *     verdict = gate.check(call)
 *     preHooks(call)
 *     result = executor.execute(call)   // timeout+retry
 *     postHooks(call, result)
 *     session.append(ToolResult(truncated(result)))
 *   if budget exceeded: compactor.maybeCompact(session)
 * }
 *
 * The "intelligence" lives in the model + the prompt (ContextAssembler) + the
 * tools (ToolCatalog) — NOT in branching flow-control here. StateGraph and the
 * 1259-line AgentLoop god-class are gone.
 */
class AgentHarness(
    private val model: io.codepilot.harness.model.ChatModel,
    private val catalog: ToolCatalog,
    private val assembler: ContextAssembler,
    private val gate: PermissionGate,
    private val session: EventSourcedSession,
    private val cfg: HarnessConfig = HarnessConfig(),
    private val executor: ToolExecutor = ToolExecutor(),
    private val hooks: HookRunner = HookRunner(),
    private val completion: CompletionPolicy = CompletionPolicy(hooks = hooks, strict = false),
    private val compactor: Compactor? = null,
    private val approval: ApprovalHandler? = null,
) {
    var stepsDone: Int = 0
        private set

    fun run(goal: String): Flow<HarnessUiEvent> = flow {
        ensureStarted(goal)

        while (stepsDone < cfg.maxSteps) {
            stepsDone++
            val ctx = assembler.assemble(session, catalog.schemas, cfg.requestMaxTokens)

            val textBuilder = StringBuilder()
            val pendingCalls = mutableListOf<AssistantToolCall>()
            var stopKind: StopKind? = null
            var stopDetail: String? = null

            model.stream(ctx).collect { ev ->
                when (ev) {
                    is TextDelta -> {
                        textBuilder.append(ev.text)
                        emit(HarnessUiEvent.Delta(ev.text))
                    }
                    is AssistantToolCall -> pendingCalls.add(ev)
                    is StopReason -> { stopKind = ev.kind; stopDetail = ev.detail }
                    else -> {}
                }
            }

            val callsAsSpecs = pendingCalls.map { ToolCallSpec(it.callId, it.name, it.argumentsJson) }
            emit(HarnessUiEvent.Persisted(session.append(AssistantMessageAdded(text = textBuilder.toString(), toolCalls = callsAsSpecs))))

            when (stopKind) {
                StopKind.ERROR -> { finish(RunFinished.ERROR, stepsDone, stopDetail); return@flow }
                null -> { finish(RunFinished.ERROR, stepsDone, "stream ended without stop reason"); return@flow }
                else -> {}
            }

            if (pendingCalls.isEmpty()) {
                // end_turn: ask CompletionPolicy. In strict mode it may force another turn.
                when (val d = completion.afterTurn(session, hadEdits = false)) {
                    is StopDirective.Stop -> { finish(RunFinished.COMPLETED, stepsDone); return@flow }
                    is StopDirective.Continue -> session.append(UserMessageAdded(text = d.reason))
                }
                continue
            }

            executePendingCalls(pendingCalls)
            maybeCompact()
        }
        finish(RunFinished.MAX_STEPS, cfg.maxSteps)
    }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<HarnessUiEvent>.ensureStarted(goal: String) {
        val events = session.events()
        if (events.none { it is RunStarted }) {
            emit(HarnessUiEvent.Persisted(session.append(RunStarted(sessionId = "local", goal = goal))))
        }
        if (events.none { it is UserMessageAdded }) {
            emit(HarnessUiEvent.Persisted(session.append(UserMessageAdded(text = goal))))
        }
    }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<HarnessUiEvent>.executePendingCalls(
        calls: List<AssistantToolCall>,
    ) {
        var hadEdits = false
        for (call in calls) {
            val spec = ToolCallSpec(call.callId, call.name, call.argumentsJson)
            val verdict = gate.check(spec, catalog)

            val preset: ToolOutput? = when (verdict) {
                is Verdict.Deny -> ToolOutput.failure("denied: ${verdict.reason}")
                is Verdict.Ask -> {
                    emit(HarnessUiEvent.PermissionNeeded(call.callId, call.name, verdict.reason))
                    val decision = approval?.decide(call, verdict.reason)
                        ?: Verdict.Deny("no approval handler attached")
                    session.append(PermissionDecisionRecorded(
                        callId = call.callId, tool = call.name,
                        verdict = verdictLabel(decision), reason = reasonOf(decision),
                    ))
                    when (decision) {
                        is Verdict.Allow -> null
                        is Verdict.Ask -> ToolOutput.failure("approval unresolved")
                        is Verdict.Deny -> ToolOutput.failure("denied: ${decision.reason}")
                    }
                }
                Verdict.Allow -> null
            }

            if (preset != null) {
                executeAndRecord(call, preset)
            } else {
                // Run pre-hooks: may veto or rewrite the call.
                when (val pre = hooks.pre(spec, catalog)) {
                    is PreResult.Veto -> executeAndRecord(call, ToolOutput.failure("vetoed: ${pre.reason}"))
                    is PreResult.Proceed -> {
                        val rewrittenCall = if (pre.call.argumentsJson != call.argumentsJson) {
                            call.copy(argumentsJson = pre.call.argumentsJson)
                        } else call
                        if (isWriteTool(call.name)) hadEdits = true
                        executeAndRecord(rewrittenCall)
                    }
                }
            }
        }
        // Post-tool completion hooks run here (e.g. format/lint after edits).
        // In strict mode a Continue directive injects the reason as a user
        // message for the next model turn. In the default non-strict mode
        // this is a no-op (Stop), so the loop proceeds to the next turn.
        when (val d = completion.afterTurn(session, hadEdits = hadEdits)) {
            is StopDirective.Stop -> { /* proceed to next loop iteration */ }
            is StopDirective.Continue -> session.append(UserMessageAdded(text = d.reason))
        }
    }

    private fun isWriteTool(name: String): Boolean = name.startsWith("write_") ||
        name.startsWith("edit_") || name.startsWith("apply_") ||
        name.startsWith("mcp.") || name == "subagent"

    private suspend fun kotlinx.coroutines.flow.FlowCollector<HarnessUiEvent>.executeAndRecord(
        call: AssistantToolCall,
        preset: ToolOutput? = null,
    ) {
        val raw: ToolOutput = preset ?: executor.execute(call, catalog)
        // Truncate large outputs and run post-hooks before persisting.
        val truncated = truncateOutput(raw)
        val spec = ToolCallSpec(call.callId, call.name, call.argumentsJson)
        val post = hooks.post(spec, truncated)
        emit(HarnessUiEvent.Persisted(session.append(ToolResultAdded(
            callId = call.callId, tool = call.name,
            ok = post.ok, output = post.stdout.ifEmpty { post.stderr },
            truncated = post.truncated || post.stdout.length > cfg.maxToolOutputChars,
        ))))
    }

    private fun truncateOutput(o: ToolOutput): ToolOutput {
        val cap = cfg.maxToolOutputChars
        val out = o.stdout.ifEmpty { o.stderr }
        return if (out.length <= cap) o
        else o.copy(stdout = out.take(cap) + "\n...[truncated ${out.length - cap} chars]", truncated = true)
    }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<HarnessUiEvent>.maybeCompact() {
        if (cfg.compactAfterChars != null) {
            val total = session.events().sumOf { it.toString().length }
            if (total > cfg.compactAfterChars) {
                compactor?.maybeCompact(session)
            }
        } else {
            compactor?.maybeCompact(session)
        }
    }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<HarnessUiEvent>.finish(status: String, steps: Int, detail: String? = null) {
        emit(HarnessUiEvent.Persisted(session.append(RunFinished(status = status, totalSteps = steps, detail = detail))))
    }

    private fun verdictLabel(v: Verdict): String = when (v) {
        is Verdict.Allow -> "allow"
        is Verdict.Ask -> "ask"
        is Verdict.Deny -> "deny"
    }

    private fun reasonOf(v: Verdict): String? = when (v) {
        is Verdict.Allow -> null
        is Verdict.Ask -> v.reason
        is Verdict.Deny -> v.reason
    }
}
