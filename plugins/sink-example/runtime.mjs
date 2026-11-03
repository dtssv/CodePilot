// Reference implementation of a plugin that registers an ADDITIVE EVENT SINK —
// a write-through MIRROR of the session's JSONL event log to an external data
// source (NAS / OSS / DB / webhook). This is how you "save a copy elsewhere"
// without ever touching the source of truth.
//
// The contract (and the rules a sink plugin must follow):
//
// 1. Export a RuntimeFactory with `{ name, create(deps) }`. `deps.toolkit` is
//    the ABI boundary — the only sanctioned way to reach the core.
//
// 2. Register the sink during `create`, before the first prompt, via
//    `deps.toolkit.registerEventSink(sink)`. The sink's `write(sessionId,
//    line)` receives the EXACT JSONL line already written locally, AFTER the
//    canonical append resolves. `line` is one event, JSON, without a trailing
//    newline. Optional `flush(sessionId)` and `close()` run on demand/dispose.
//
// 3. Never import @codepilot/core — the module loads from wherever the plugin
//    was installed, so the core is not resolvable here.
//
// Fail-soft is enforced by the HOST, not you: the host wraps your sink in a
// bounded, single-flight queue, so a slow or throwing `write` can never block
// or fail the canonical JSONL write. JSONL remains the single source of truth;
// your mirror is best-effort (the host may drop the oldest queued line under
// sustained backpressure). Keep `write` simple and idempotent where possible.
//
// This example mirrors each line to `~/.codepilot/mirror/<sessionId>.jsonl`.
// A real plugin would stream to S3/OSS, POST to a webhook, or insert into a DB.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export default {
  name: "sink-example",
  create(deps) {
    const dir = join(homedir(), ".codepilot", "mirror");
    let ready = mkdir(dir, { recursive: true }).catch(() => undefined);

    deps.toolkit.registerEventSink({
      async write(sessionId, line) {
        await ready;
        // One JSONL line per event — identical to the canonical log format.
        await appendFile(join(dir, `${sessionId}.jsonl`), line + "\n", "utf-8");
      },
      // flush/close are optional; appendFile needs no explicit flush and there
      // is no handle to release, so we omit them here.
    });

    // Delegate everything else to the built-in loop unchanged.
    return {
      name: "sink-example",
      async prompt(input, runDeps) {
        return deps.toolkit.runDefault(input, runDeps);
      },
      cancel() {},
      state() {
        return "idle";
      },
    };
  },
};
