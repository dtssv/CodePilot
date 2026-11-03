// Plan-file persistence: write/read round trip, slug derivation, listing, and
// the in-place status rewrite. The status rewrite previously used a broken
// capture-group `replace` that clobbered the session id, emitted a literal
// `$2` for the created date, and dropped the closing `_` of the markdown
// italic — these tests lock in the corrected line-scoped rewrite.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePlanFile,
  readPlanFile,
  listPlanFiles,
  setPlanFileStatus,
  deletePlanFile,
  planSlug,
  plansDir,
} from "../src/plans.js";
import type { PlanStep } from "../src/types.js";

let cwd: string;
const sessionId = "ses_abc123XYZ";
const steps: PlanStep[] = [
  { id: "s1", title: "read the module", status: "completed" },
  { id: "s2", title: "make the edit", status: "in_progress" },
  { id: "s3", title: "run the tests", status: "pending" },
];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cp-plans-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// Keep plan files inside the temp cwd so the test never touches ~/.codepilot.
const opts = () => ({ plansDirectory: join(cwd, "plans") });

describe("planSlug", () => {
  it("slugifies the summary and appends a session-id hash", () => {
    const slug = planSlug(sessionId, "Refactor the Parser!!");
    expect(slug).toMatch(/^refactor-the-parser-[a-z0-9]{1,6}$/);
  });

  it("falls back to 'plan' when there is no summary", () => {
    expect(planSlug(sessionId)).toMatch(/^plan-/);
  });
});

describe("writePlanFile / readPlanFile round trip", () => {
  it("writes a plan and reads it back with steps and status", async () => {
    const written = await writePlanFile(cwd, sessionId, "my plan", steps, opts());
    expect(written.status).toBe("pending");
    const back = await readPlanFile(cwd, written.slug, opts());
    expect(back).toBeDefined();
    expect(back!.title).toBe("my plan");
    expect(back!.status).toBe("pending");
    expect(back!.steps.map((s) => [s.id, s.status])).toEqual([
      ["s1", "completed"],
      ["s2", "in_progress"],
      ["s3", "pending"],
    ]);
  });

  it("returns undefined for a missing slug", async () => {
    expect(await readPlanFile(cwd, "nope-123456", opts())).toBeUndefined();
  });
});

describe("setPlanFileStatus (in-place rewrite)", () => {
  it("flips the status token without corrupting the metadata line", async () => {
    const written = await writePlanFile(cwd, sessionId, "approve me", steps, opts());
    await setPlanFileStatus(cwd, written.slug, "approved", opts());

    const raw = readFileSync(written.path, "utf-8");
    const metaLine = raw.split(/\r?\n/).find((l) => l.startsWith("_Session:"))!;
    // Session id and created date are preserved…
    expect(metaLine).toContain(`_Session: ${sessionId}`);
    expect(metaLine).toContain("Created:");
    // …the status flipped…
    expect(metaLine).toContain("Status: approved");
    expect(metaLine).not.toContain("Status: pending");
    // …and the closing markdown italic underscore survives.
    expect(metaLine.trimEnd().endsWith("_")).toBe(true);
    // No literal capture-group placeholder leaked into the file.
    expect(raw).not.toContain("$2");

    const back = await readPlanFile(cwd, written.slug, opts());
    expect(back!.status).toBe("approved");
    // The session id must NOT have been clobbered by the old regex bug.
    expect(raw).not.toContain("_Session: pending");
  });

  it("can move through pending → approved → rejected", async () => {
    const w = await writePlanFile(cwd, sessionId, "lifecycle", steps, opts());
    await setPlanFileStatus(cwd, w.slug, "approved", opts());
    expect((await readPlanFile(cwd, w.slug, opts()))!.status).toBe("approved");
    await setPlanFileStatus(cwd, w.slug, "rejected", opts());
    expect((await readPlanFile(cwd, w.slug, opts()))!.status).toBe("rejected");
  });

  it("is a no-op (no throw) for a missing file", async () => {
    await expect(
      setPlanFileStatus(cwd, "ghost-000000", "approved", opts()),
    ).resolves.toBeUndefined();
  });
});

describe("listPlanFiles / deletePlanFile", () => {
  it("lists written plans and removes a deleted one", async () => {
    const a = await writePlanFile(cwd, "ses_a", "alpha", steps, opts());
    await writePlanFile(cwd, "ses_b", "beta", steps, opts());
    const listed = await listPlanFiles(cwd, opts());
    expect(listed.map((p) => p.title).sort()).toEqual(["alpha", "beta"]);
    await deletePlanFile(cwd, a.slug, opts());
    const after = await listPlanFiles(cwd, opts());
    expect(after.map((p) => p.title)).toEqual(["beta"]);
  });

  it("returns [] when the plans dir does not exist", async () => {
    expect(await listPlanFiles(cwd, { plansDirectory: join(cwd, "none") })).toEqual([]);
  });
});

describe("plansDir override", () => {
  it("honours an absolute override and a cwd-relative override", () => {
    expect(plansDir(cwd, "/abs/plans")).toBe("/abs/plans");
    expect(plansDir(cwd, "rel/plans")).toBe(join(cwd, "rel/plans"));
  });
});
