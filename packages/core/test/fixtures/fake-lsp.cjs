// Fake language server for tests. Mode (argv[2]): "push" publishes diagnostics
// on open/change, "pull" answers textDocument/diagnostic, "mute" never answers
// shutdown. Every line containing ERR is an error. After `initialized` it sends
// a string-id request and ignores everything until that is answered.
const mode = process.argv[2];
let buf = Buffer.alloc(0);
let blocked = false;
const docs = new Map();
const send = (m) => {
  const b = JSON.stringify({ jsonrpc: "2.0", ...m });
  process.stdout.write("Content-Length: " + Buffer.byteLength(b) + "\r\n\r\n" + b);
};
const diags = (text) =>
  text.split("\n").flatMap((l, i) =>
    l.includes("ERR")
      ? [{ range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } }, severity: 1, message: "bad " + l.trim(), source: "fake", code: 7 }]
      : []);
const publish = (uri, version) => send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: diags(docs.get(uri)) } });
function handle(m) {
  if (m.id === "reg1" && m.method === undefined) { blocked = false; return; }
  if (blocked) return;
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { capabilities: mode === "pull" ? { diagnosticProvider: { interFileDependencies: false } } : {} } });
    case "initialized":
      blocked = true;
      return send({ id: "reg1", method: "client/registerCapability", params: { registrations: [] } });
    case "textDocument/didOpen":
      docs.set(m.params.textDocument.uri, m.params.textDocument.text);
      if (mode === "push") setTimeout(() => publish(m.params.textDocument.uri, 1), 20);
      return;
    case "textDocument/didChange":
      docs.set(m.params.textDocument.uri, m.params.contentChanges[0].text);
      if (mode === "push") setTimeout(() => publish(m.params.textDocument.uri, m.params.textDocument.version), 20);
      return;
    case "textDocument/diagnostic":
      return send({ id: m.id, result: { kind: "full", items: diags(docs.get(m.params.textDocument.uri) ?? "") } });
    case "shutdown":
      if (mode !== "mute") send({ id: m.id, result: null });
      return;
    case "exit":
      process.exit(0);
  }
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    handle(msg);
  }
});
