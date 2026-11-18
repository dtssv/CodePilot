/** Static section registry + join for the cached system prefix. */

export interface StaticSection {
  name: string;
  order: number;
  source?: "core" | "model";
  /**
   * Tools this section requires. Renders only when every listed tool is
   * exposed this session. Omit for always-on sections.
   */
  requires?: string[];
  text: string;
}

/** Assemble sections: dedup by name (model overrides core), sort, join. */
export function assembleSections(sections: StaticSection[], have?: Set<string>): string {
  const byName = new Map<string, StaticSection>();
  for (const s of sections) {
    const existing = byName.get(s.name);
    if (existing) {
      const canOverride =
        (existing.source ?? "core") === "core" && s.source === "model";
      if (!canOverride) {
        throw new Error(`duplicate system-prompt section "${s.name}"`);
      }
    }
    byName.set(s.name, s);
  }
  const ordered = [...byName.values()]
    .filter((s) => !s.requires || !have || s.requires.every((t) => have.has(t)))
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ordered.map((s) => s.text).join("\n\n") + "\n";
}
