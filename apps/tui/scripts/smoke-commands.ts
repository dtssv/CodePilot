/**
 * Smoke test for the slash command dispatcher.
 */
import { runCommand, isCommand } from "../src/ui/commands.js";

const ctx = {
  controller: { kind: "mock" as const, listSessions: async () => [], runGoal: async () => ({ status: "blocked" as const }) },
  cwd: "/tmp",
};

const cases: { input: string; expected: string }[] = [
  { input: "/help", expected: "system" },
  { input: "/model claude-sonnet-4-5", expected: "set-model" },
  { input: "/mode yolo", expected: "set-mode" },
  { input: "/mode auto-edit", expected: "set-mode" },
  { input: "/mode bogus", expected: "system" },
  { input: "/agent chat", expected: "set-agent-mode" },
  { input: "/agent plan", expected: "set-agent-mode" },
  { input: "/agent agent", expected: "set-agent-mode" },
  { input: "/agent bogus", expected: "system" },
  { input: "/plan", expected: "show-plan" },
  { input: "/compact", expected: "compact" },
  { input: "/resume abc-123", expected: "resume" },
  { input: "/sessions", expected: "list-sessions" },
  { input: "/goal fix all the bugs", expected: "goal" },
  { input: "/clear", expected: "clear" },
  { input: "/exit", expected: "exit" },
  { input: "/quit", expected: "exit" },
  { input: "/unknown", expected: "system" },
  { input: "hello world", expected: "submit-prompt" },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const r = runCommand(c.input, ctx);
  const got = r.kind;
  const ok = got === c.expected;
  if (!ok) fail++;
  else pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.input} → ${got}${ok ? "" : ` (expected ${c.expected})`}`);
}

// Extra structural assertions on the new agent-mode cases.
const agentChat = runCommand("/agent chat", ctx);
if (agentChat.kind !== "set-agent-mode" || agentChat.mode !== "chat") {
  console.error("FAIL: /agent chat did not produce set-agent-mode{chat}");
  fail++;
} else {
  console.log("PASS  /agent chat → set-agent-mode{chat}");
  pass++;
}
const agentPlan = runCommand("/agent plan", ctx);
if (agentPlan.kind !== "set-agent-mode" || agentPlan.mode !== "plan") {
  console.error("FAIL: /agent plan did not produce set-agent-mode{plan}");
  fail++;
} else {
  console.log("PASS  /agent plan → set-agent-mode{plan}");
  pass++;
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("isCommand('/foo'):", isCommand("/foo"));
console.log("isCommand('foo'):", isCommand("foo"));

if (fail > 0) process.exit(1);