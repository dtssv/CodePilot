/**
 * @codepilot/protocol — public surface. Consumers (TUI, VSCode, IDEA) usually
 * need just `Peer` + `StdioTransport` + the `server.ts` wire types. Two
 * subpaths avoid pulling unneeded deps: `@codepilot/protocol/ws` (WS server,
 * drags in `ws`) and `@codepilot/protocol/rpc` (`Peer` + JSON-RPC types, no
 * `@codepilot/core` — what the browser UI imports).
 */

export * from "./rpc.js";
export * from "./server.js";
export {
  startAcpServer,
  registerAcpServer,
  ACP_PROTOCOL_VERSION,
  type AcpServerOptions,
  type AcpServerHandle,
  type AcpSessionFactory,
} from "./acp.js";
export {
  writeServeInfo,
  clearServeInfo,
  readLiveServeInfo,
  serveInfoWsUrl,
  type ServeInfo,
} from "./serve-info.js";
export {
  waitForLiveServeInfo,
  discoverOrSpawnDaemon,
  type DiscoverOrSpawnOptions,
  type DiscoverOrSpawnResult,
  type Spawner as DaemonSpawner,
} from "./engineConnect.js";