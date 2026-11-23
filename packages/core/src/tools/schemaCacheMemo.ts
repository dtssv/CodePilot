// Tiny memo table with no imports from ToolDef / zod — breaks the
 // schemaCache ↔ types cycle so unregister can invalidate synchronously.

import type { ProviderToolDef } from "../providers/types.js";

const providerDefMemo = new Map<string, ProviderToolDef>();

export function getMemoisedProviderToolDef(name: string): ProviderToolDef | undefined {
  return providerDefMemo.get(name);
}

export function setMemoisedProviderToolDef(name: string, def: ProviderToolDef): void {
  providerDefMemo.set(name, def);
}

export function invalidateProviderToolDef(name: string): void {
  providerDefMemo.delete(name);
}

export function clearProviderToolDefMemo(): void {
  providerDefMemo.clear();
}
