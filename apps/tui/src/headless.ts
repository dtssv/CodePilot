/**
 * Headless / print mode (`--print` / `--output-format`).
 *
 * When the TUI is invoked with `--print`/`-p` (and a prompt), we skip the Ink
 * UI entirely and run a single prompt to completion, writing machine-readable
 * output to stdout. The output contract (the `text` / `json` / `stream-json`
 * formats, the `result` schema, and the format parser) is the shared core
 * contract — every non-interactive entry point produces identical output so a
 * `jq` pipeline or CI script works against any of them unchanged.
 *
 * Headless mode never renders the Ink UI, never prompts interactively for
 * permissions (it requires --yolo or a permission mode that auto-approves,
 * otherwise tool calls that need approval are denied), and exits as soon as
 * the prompt completes (or errors).
 */
export {
  runHeadless,
  parseOutputFormat,
  type OutputFormat,
  type HeadlessResult,
  type HeadlessOptions,
} from "@codepilot/core";
