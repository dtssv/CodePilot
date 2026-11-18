export type { SearchHit, SearchLocale } from "./types.js";
export { formatFetchError, SEARCH_TIMEOUT_MS } from "./types.js";
export { resolveSearchBackend, resolveSearchLocale } from "./backend.js";
export {
  hitHost,
  hostMatchesDomain,
  filterSearchHitsByDomain,
  formatSearchResultsForModel,
} from "./filter.js";
export { parseDuckDuckGoHtml, parseBingHtml } from "./html.js";
export { listTemplateEnvVars, interpolateEnv } from "./providers/custom.js";
export { webSearchTool } from "./tool.js";
