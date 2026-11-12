/**
 * Headless / print mode (`--print` / `--output-format`): skip the Ink UI, run
 * one prompt to completion, write machine-readable stdout. The output contract
 * (`text`/`json`/`stream-json`, `result` schema) is the shared core contract so
 * any non-interactive entry point is interchangeable for `jq`/CI. Never renders
 * the UI; never prompts interactively (needs --yolo/auto-approve, else tool
 * calls needing approval are denied); exits on completion or error.
 */
export {
  runHeadless,
  parseOutputFormat,
  type OutputFormat,
  type HeadlessResult,
  type HeadlessOptions,
} from "@codepilot/core";
