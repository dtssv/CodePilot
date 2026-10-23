import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  extractDeliveryRootsFromText,
  isUnderDeliveryRoots,
  mergeDeliveryRoots,
  normalizeRoot,
  rootFromPathToken,
} from "../src/deliveryRoots.js";
import { guardDeliveryWrite } from "../src/tools/_shared.js";
import type { ToolContext } from "../src/tools/types.js";

describe("deliveryRoots extraction", () => {
  const cwd = "/Users/me/workspace/app";

  it("defaults merge keeps cwd and adds absolute dirs", () => {
    const roots = mergeDeliveryRoots([cwd], ["/tmp/out", "/tmp/out/"]);
    expect(roots).toContain(normalizeRoot(cwd));
    expect(roots).toContain(normalizeRoot("/tmp/out"));
  });

  it("extracts absolute and relative path tokens as directory roots", () => {
    const text =
      "请把结果写到 /Users/me/web/test/index.html ，参考 ../shared/lib.ts";
    const found = extractDeliveryRootsFromText(text, cwd);
    expect(found).toContain(normalizeRoot("/Users/me/web/test"));
    expect(found.some((r) => r.endsWith("shared") || r.includes("shared"))).toBe(
      true,
    );
  });

  it("expands ~/ paths", () => {
    const r = rootFromPathToken("~/projects/foo/bar.ts", cwd);
    expect(r).toBe(normalizeRoot(resolve(homedir(), "projects/foo")));
  });

  it("ignores URLs", () => {
    expect(
      extractDeliveryRootsFromText("see https://example.com/a/b.html", cwd),
    ).toEqual([]);
  });

  it("extracts 目录在:/abs/path without a space after the colon", () => {
    const found = extractDeliveryRootsFromText(
      "请帮我复刻示例，目录在:/Users/me/web/testnn",
      cwd,
    );
    expect(found).toContain(normalizeRoot("/Users/me/web/testnn"));
  });

  it("still ignores https:// after a colon", () => {
    expect(
      extractDeliveryRootsFromText(
        "参考 https://api-docs.deepseek.com/zh-cn/news/news261017，目录在:/Users/me/web/testnn",
        cwd,
      ),
    ).toEqual([normalizeRoot("/Users/me/web/testnn")]);
  });

  it("isUnderDeliveryRoots matches children", () => {
    const roots = [normalizeRoot("/proj")];
    expect(isUnderDeliveryRoots("/proj/src/a.ts", roots, cwd)).toBe(true);
    expect(isUnderDeliveryRoots("/other/x.ts", roots, cwd)).toBe(false);
  });
});

describe("guardDeliveryWrite", () => {
  const cwd = "/Users/me/workspace/app";

  function ctx(partial: Partial<ToolContext> = {}): ToolContext {
    return {
      cwd,
      artifact: async () => "art",
      readArtifact: async () => "",
      deliveryRoots: [normalizeRoot(cwd)],
      ...partial,
    };
  }

  it("allows writes under delivery roots", async () => {
    const r = await guardDeliveryWrite(ctx(), "src/a.ts");
    expect(r).toBeNull();
  });

  it("refuses writes outside when no askUser", async () => {
    const r = await guardDeliveryWrite(ctx(), "/tmp/elsewhere/x.ts");
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/delivery_root/);
  });

  it("exempts ~/.codepilot scratch paths", async () => {
    const scratch = resolve(homedir(), ".codepilot/projects/abc/scratch/s1");
    const r = await guardDeliveryWrite(
      ctx({ scratchDir: scratch }),
      resolve(scratch, "tmp.js"),
    );
    expect(r).toBeNull();
  });

  it("asks and allows when user approves", async () => {
    const roots = [normalizeRoot(cwd)];
    const expanded: string[] = [];
    const r = await guardDeliveryWrite(
      ctx({
        deliveryRoots: roots,
        askUser: async () => ({
          delivery_root: "Allow this folder for this task",
        }),
        addDeliveryRoot: (dir) => {
          const m = mergeDeliveryRoots(roots, [dir]);
          roots.length = 0;
          roots.push(...m);
        },
        expandSandboxWritable: async (dir) => {
          expanded.push(dir);
        },
      }),
      "/tmp/elsewhere/x.ts",
    );
    expect(r).toBeNull();
    expect(roots.some((x) => x.includes("elsewhere") || x === normalizeRoot("/tmp/elsewhere"))).toBe(
      true,
    );
    // Approving delivery root must also expand the OS sandbox jail.
    expect(expanded.some((d) => d.includes("elsewhere"))).toBe(true);
  });
});
