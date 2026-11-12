/**
 * @codepilot/protocol public surface: `Peer` + `StdioTransport` + server.ts
 * wire types. Subpaths avoid extra deps: `…/ws` (WS server, drags in `ws`),
 * `…/rpc` (no @codepilot/core — browser UI imports).
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