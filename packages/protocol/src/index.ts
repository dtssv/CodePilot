/**
 * @codepilot/protocol — public surface.
 *
 * Consumers (TUI, VSCode, IDEA plugins) typically only need `Peer` and
 * `StdioTransport` to talk to a `codepilot serve` subprocess, plus the wire
 * types in `server.ts`.
 */

export * from "./rpc.js";
export * from "./server.js";