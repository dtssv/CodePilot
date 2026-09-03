// Minimal OpenAI-compatible mock server for E2E smoke tests.
// Behavior: first request -> emits a tool_call (bash echo). Second request (with tool result) -> final text answer.
import http from "node:http";

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body);
    const hasToolResult = payload.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: payload.model };
    if (!hasToolResult) {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hello-from-tool" }) } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Tool output received. Task complete." }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(18321, "127.0.0.1", () => console.log("mock listening :18321"));
