// MCP tool-name normalization and naming helpers.
//
// Provider APIs enforce a 64-char limit on function names; MCP tool names of
// the form `mcp__<server>__<tool>` can exceed that. This module normalises
// long names to fit while preserving uniqueness via a short hash, and
// provides the reverse parse + `@mcp:` reference resolution used by the
// session layer.

import { createHash } from "node:crypto";
import type { McpToolDescriptor } from "./mcp-types.js";
import { MCP_TOOL_NAME_MAX_LENGTH } from "./mcp-types.js";

// Structural type for the manager — avoids a circular import on `McpManager`.
// `resolveMcpReferences` only needs `getClient`, so we accept anything with
// that method.
interface McpManagerLike {
  getClient(server: string): { readResource(uri: string): Promise<{ contents: Array<{ text?: string; blob?: string }> }> } | null;
}

// ---------------------------------------------------------------------------
// Normalization (64-char limit + hash collision prevention)
// ---------------------------------------------------------------------------

/**
 * Normalize an MCP tool name to fit within {@link MCP_TOOL_NAME_MAX_LENGTH}
 * characters while preserving uniqueness.
 *
 * The canonical form is `mcp__<server>__<tool>`. When that fits, it is
 * returned unchanged. When it exceeds the limit, the middle of the name is
 * truncated and an 8-char hash (first 8 hex chars of sha256 of the full
 * name) is appended, e.g. `mcp__serv…__tool__a1b2c3d4`. The hash guarantees
 * that two distinct long names cannot collapse to the same normalized form.
 *
 * @param server  The MCP server name (config key).
 * @param tool    The tool name advertised by the server.
 * @returns the normalized, provider-safe tool name.
 */
export function normalizeMcpToolName(server: string, tool: string): string {
  const full = `mcp__${server}__${tool}`;
  if (full.length <= MCP_TOOL_NAME_MAX_LENGTH) return full;
  // Hash the full name so collisions on the truncated prefix are impossible.
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  // Keep the `mcp__` prefix and the hash suffix; truncate the middle.
  // Reserve: "mcp__" (5) + "__" (2) + hash (8) = 15 chars of overhead.
  const budget = MCP_TOOL_NAME_MAX_LENGTH - 15;
  // Give the server a fair share; the tool name gets the rest.
  const serverPart = server.slice(0, Math.max(1, Math.floor(budget / 3)));
  const toolPart = tool.slice(0, Math.max(1, budget - serverPart.length));
  return `mcp__${serverPart}__${toolPart}__${hash}`;
}

/**
 * Build a reverse-lookup map from normalized tool names to the original
 * `(server, tool)` pair, for a set of descriptors. Used by the session layer
 * so the registry wrapper can invoke the correct server tool even when the
 * registered name was truncated.
 */
export function buildMcpToolNameMap(
  tools: McpToolDescriptor[]
): Map<string, { server: string; tool: string }> {
  const m = new Map<string, { server: string; tool: string }>();
  for (const t of tools) {
    m.set(normalizeMcpToolName(t.server, t.name), { server: t.server, tool: t.name });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Canonical naming helpers (back-compat with existing session wiring)
// ---------------------------------------------------------------------------

/** Build the canonical `mcp__<server>__<tool>` name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Build the canonical `mcp__<server>__resource__<name>` name. */
export function mcpResourceToolName(server: string, resource: string): string {
  return `mcp__${server}__resource__${resource}`;
}

/** Parse an `mcp__<server>__<tool>` or `mcp__<server>__resource__<name>`
 *  name back into its parts. Returns `null` for anything that does not look
 *  like a tool name we generate. */
export function parseMcpToolName(
  name: string
): { server: string; tool: string; kind: "tool" | "resource" } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const parts = rest.split("__");
  if (parts.length < 2) return null;
  if (parts.length >= 3 && parts[1] === "resource") {
    return {
      server: parts[0]!,
      tool: parts.slice(2).join("__"),
      kind: "resource",
    };
  }
  return { server: parts[0]!, tool: parts.slice(1).join("__"), kind: "tool" };
}

// ---------------------------------------------------------------------------
// `@mcp:` reference resolution
// ---------------------------------------------------------------------------

/** Regex matching `@mcp:<server>/<uri>` tokens in user prompts. The server
 *  name is `[A-Za-z0-9_-]+`; the URI is everything up to the next whitespace
 *  or end of string. Example: `@mcp:github/repos/foo/bar` →
 *  `{ server: "github", uri: "repos/foo/bar" }`. */
export const MCP_REF_REGEX = /@mcp:([A-Za-z0-9_.-]+)\/(\S+)/g;

/** Parse an `@mcp:<server>/<uri>` token. Returns null if the string does not
 *  look like an MCP resource reference. */
export function parseMcpReference(
  token: string
): { server: string; uri: string } | null {
  const m = /^@mcp:([A-Za-z0-9_.-]+)\/(\S+)$/.exec(token);
  if (!m) return null;
  return { server: m[1]!, uri: m[2]! };
}

/** Scan a text for `@mcp:<server>/<uri>` references and resolve each via the
 *  manager, returning a concatenation of their textual contents suitable for
 *  injection as user context. Unknown servers or failed reads are skipped
 *  with an inline note. The `uris` are unquoted (the `@mcp:` prefix is
 *  stripped before lookup). */
export async function resolveMcpReferences(
  text: string,
  manager: McpManagerLike
): Promise<{ text: string; resolved: number }> {
  const refs: { server: string; uri: string; raw: string }[] = [];
  for (const m of text.matchAll(MCP_REF_REGEX)) {
    refs.push({ server: m[1]!, uri: m[2]!, raw: m[0] });
  }
  if (refs.length === 0) return { text, resolved: 0 };
  let resolved = 0;
  const blocks: string[] = [];
  for (const r of refs) {
    const client = manager.getClient(r.server);
    if (!client) {
      blocks.push(`[mcp:${r.server}] (unknown server) ${r.uri}`);
      continue;
    }
    try {
      const res = await client.readResource(r.uri);
      const body = (res.contents ?? [])
        .map((c) => c.text ?? (c.blob ? `(base64 blob, ${c.blob.length} chars)` : "(empty)"))
        .join("\n");
      blocks.push(`[mcp:${r.server} ${r.uri}]\n${body}`);
      resolved++;
    } catch (e) {
      blocks.push(`[mcp:${r.server} ${r.uri}] (error: ${(e as Error).message})`);
    }
  }
  return { text: blocks.join("\n\n"), resolved };
}
