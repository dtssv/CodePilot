/**
 * Smoke test: exercises the state reducer with a simulated event sequence
 * and verifies row accumulation, streaming folds, usage summation, and
 * collaboration-mode transitions.
 */
import { reducer, initialState, addUsage } from "../src/ui/state.js";

const s0 = initialState({ sessionId: "abc", cwd: "/tmp", model: "m", permissionMode: "ask", agentMode: "agent" });
if (s0.agentMode !== "agent") {
  console.error("FAIL: initialState agentMode not applied, got", s0.agentMode);
  process.exit(1);
}
console.log("PASS  initialState agentMode default");

const u1 = reducer(s0, { type: "event", event: { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hello" }] } });
const a1delta1 = reducer(u1, { type: "event", event: { type: "message_delta", messageId: "a1", delta: { type: "text", text: "hi " } } });
const a1delta2 = reducer(a1delta1, { type: "event", event: { type: "message_delta", messageId: "a1", delta: { type: "text", text: "there" } } });
const a1final = reducer(a1delta2, { type: "event", event: { type: "message", id: "a1", role: "assistant", content: [{ type: "text", text: "hi there" }] } });
const used = reducer(a1final, { type: "event", event: { type: "usage", usage: { input: 5, output: 8, costUSD: 0.0002 } } });
const used2 = reducer(used, { type: "event", event: { type: "usage", usage: { input: 3, output: 4, costUSD: 0.0001 } } });

console.log("rows count:", used2.rows.length);
const last = used2.rows[used2.rows.length - 1]!;
console.log("last row kind:", last.kind);
const total = used2.usage.input + used2.usage.output;
console.log("usage total:", total);
const sum = addUsage({ input: 1, output: 2 }, { input: 3, output: 4, cacheRead: 5 });
console.log("addUsage:", sum);

// Validate the streaming fold worked.
const assistant = a1final.rows.find((r) => r.kind === "assistant");
if (assistant === undefined || assistant.kind !== "assistant") {
  console.error("FAIL: assistant row missing");
  process.exit(1);
}
console.log("assistant text:", JSON.stringify(assistant.msg.text));
if (assistant.msg.text !== "hi there") {
  console.error("FAIL: expected 'hi there' got", assistant.msg.text);
  process.exit(1);
}
if (assistant.msg.streaming !== false) {
  console.error("FAIL: expected streaming=false after final message");
  process.exit(1);
}

// Plan event
const planned = reducer(a1final, { type: "event", event: { type: "plan", steps: [
  { id: "s1", title: "step one", status: "completed" },
  { id: "s2", title: "step two", status: "in_progress" },
] } });
console.log("plan rows after plan event:", planned.rows.filter(r => r.kind === "plan").length);

// Collaboration mode: optimistic local switch.
const switched = reducer(planned, { type: "set-agent-mode", mode: "plan" });
if (switched.agentMode !== "plan") {
  console.error("FAIL: set-agent-mode did not update state, got", switched.agentMode);
  process.exit(1);
}
console.log("PASS  set-agent-mode{plan}");

// Collaboration mode: core-pushed `mode` event.
const corePushed = reducer(switched, { type: "event", event: { type: "mode", mode: "chat" } });
if (corePushed.agentMode !== "chat") {
  console.error("FAIL: mode event did not update agentMode, got", corePushed.agentMode);
  process.exit(1);
}
if (corePushed.notice === undefined || !corePushed.notice.includes("chat")) {
  console.error("FAIL: mode event did not set notice, got", corePushed.notice);
  process.exit(1);
}
console.log("PASS  mode event → agentMode=chat + notice");

console.log("OK");