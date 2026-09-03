/**
 * End-to-end smoke test of the mock session + permission bridge.
 * Exercises: subscribe → replay → prompt → stream → tool_call/result → status:idle.
 */
import { createMockSession } from "../src/dev/mockSession.js";
import { createPermissionBridge } from "../src/ui/controller.js";

const bridge = createPermissionBridge();
const handle = createMockSession({ cwd: "/tmp", yolo: false, bridge });
const session = handle.session;

const events: import("@codepilot/core").Event[] = [];
session.subscribe((e) => events.push(e));

// Pre-decide permission requests so the prompt can complete.
bridge.onPending((req) => {
  // Auto-allow
  setTimeout(() => bridge.resolve(req.requestId, "allow"), 0);
});

await session.prompt("hello world, please run ls");
console.log("events emitted:", events.length);
for (const e of events) {
  console.log(" -", e.type, e.type === "message" ? `(${e.role})` : "");
}

const lastStatus = events.filter((e) => e.type === "status").pop();
console.log("last status:", lastStatus);

const toolResults = events.filter((e) => e.type === "tool_result");
console.log("tool_result count:", toolResults.length);

const usage = events.filter((e) => e.type === "usage");
console.log("usage count:", usage.length);

if (lastStatus?.type !== "status" || lastStatus.status !== "idle") {
  console.error("FAIL: expected final status idle");
  process.exit(1);
}
if (toolResults.length === 0) {
  console.error("FAIL: expected at least one tool_result (we asked to run)");
  process.exit(1);
}
console.log("OK");