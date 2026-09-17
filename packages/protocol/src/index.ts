/**
 * @codepilot/protocol — public surface.
 *
 * Consumers (TUI, VSCode, IDEA plugins) typically only need `Peer` and
 * `StdioTransport` to talk to a `codepilot serve` subprocess, plus the wire
 * types in `server.ts`.
 *
 * Two subpaths exist so consumers only pay for what they use:
 *  - `@codepilot/protocol/ws` — the WebSocket server (`codepilot serve
 *    --web`). Kept out of this entry point because it drags in the `ws`
 *    package, and bundled consumers (the VSCode extension) only speak stdio.
 *  - `@codepilot/protocol/rpc` — `Peer` and the JSON-RPC types alone, with no
 *    dependency on `@codepilot/core`. This is what the browser UI imports:
 *    importing this entry point instead would pull all of core (fs,
 *    child_process, …) into a web bundle.
 */

export * from "./rpc.js";
export * from "./server.js";