/**
 * Headless / print mode (`--print` / `--output-format`): skip the Ink UI, run
 * one prompt to completion, write machine-readable stdout (`text`/`json`/
 * `stream-json`). Never renders the UI; never prompts interactively.
 */
export {
  runHeadless,
  parseOutputFormat,
  type OutputFormat,
  type HeadlessResult,
  type HeadlessOptions,
} from "@codepilot/core";
