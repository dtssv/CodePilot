/** Re-export shim — implementation lives in `./web_search/`. */
export {
  webSearchTool,
  parseDuckDuckGoHtml,
  parseBingHtml,
  resolveSearchBackend,
  resolveSearchLocale,
  hitHost,
  hostMatchesDomain,
  filterSearchHitsByDomain,
  formatSearchResultsForModel,
  formatFetchError,
  listTemplateEnvVars,
  interpolateEnv,
  SEARCH_TIMEOUT_MS,
} from "./web_search/index.js";
export type { SearchHit, SearchLocale } from "./web_search/index.js";
