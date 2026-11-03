// #13: a built-in sub-agent (explore/worker, no custom permissionMode) shared
// the parent's live PermissionEngine by default, so an allow rule the user
// approved mid-session carried into the sub-agent with no isolation boundary.
// `resolveSubagentPermissions` makes the inherit-vs-independent choice explicit:
// default "inherit" keeps today's behavior; "independent" (or a custom agent's
// own permissionMode) gives the sub-agent a fresh engine.

import { describe, expect, it } from "vitest";
import { resolveSubagentPermissions, resolveWorktreeRoots } from "../src/subagent.js";
import { PermissionEngine } from "../src/permissions.js";
import { resolveSandbox } from "../src/sandbox.js";

describe("resolveSubagentPermissions", () => {
  it("inherits the parent engine by default (built-in agent, no policy)", () => {
    const parent = new PermissionEngine({ permissionMode: "yolo" });
    const got = resolveSubagentPermissions({ parent });
    expect(got).toBe(parent);
  });

  it("inherits the parent engine when policy is explicitly 'inherit'", () => {
    const parent = new PermissionEngine({ permissionMode: "yolo" });
    const got = resolveSubagentPermissions({ parent, policy: "inherit" });
    expect(got).toBe(parent);
  });

  it("gives a fresh engine when policy is 'independent'", () => {
    const parent = new PermissionEngine({ permissionMode: "yolo" });
    const got = resolveSubagentPermissions({ parent, policy: "independent" });
    expect(got).not.toBe(parent);
    // A fresh built-in engine defaults to the safer "auto-edit", NOT the
    // parent's "yolo" — so a mid-session widening of the parent does not leak.
    expect(got.getMode()).toBe("auto-edit");
  });

  it("gives a fresh engine for a custom agent's own permissionMode (always independent)", () => {
    const parent = new PermissionEngine({ permissionMode: "auto-edit" });
    const got = resolveSubagentPermissions({ parent, customPermissionMode: "yolo" });
    expect(got).not.toBe(parent);
    expect(got.getMode()).toBe("yolo");
  });

  it("builds a fresh engine when there is no parent to inherit (minimal harness)", () => {
    const got = resolveSubagentPermissions({ parent: undefined });
    expect(got).toBeInstanceOf(PermissionEngine);
    expect(got.getMode()).toBe("auto-edit");
  });

  it("custom permissionMode wins even when policy says 'inherit'", () => {
    const parent = new PermissionEngine({ permissionMode: "ask" });
    const got = resolveSubagentPermissions({
      parent,
      customPermissionMode: "auto-edit",
      policy: "inherit",
    });
    expect(got).not.toBe(parent);
    expect(got.getMode()).toBe("auto-edit");
  });
});

// A worktree-isolated sub-agent runs in a checkout OUTSIDE the parent cwd. Its
// sandbox + delivery roots must be re-anchored to the worktree, or (a) the OS
// sandbox blocks its writes once the worktree isn't under the OS tmpdir and
// (b) its own edits read as out-of-delivery-root friction.
describe("resolveWorktreeRoots", () => {
  const parentCwd = "/repo/project";
  const worktree = "/elsewhere/cp-worktree-xyz/project";

  it("adds the worktree as a writable root without widening the parent policy", () => {
    const base = resolveSandbox({ mode: "workspace-write" }, parentCwd);
    const baseRootsBefore = [...base.writableRoots];
    const { sandbox } = resolveWorktreeRoots({
      worktreePath: worktree,
      baseSandbox: base,
      parentDeliveryRoots: [parentCwd],
    });
    expect(sandbox.writableRoots).toContain(worktree);
    // The parent's live policy is untouched (clone, not alias).
    expect(base.writableRoots).toEqual(baseRootsBefore);
    expect(base.writableRoots).not.toContain(worktree);
  });

  it("prepends the worktree to the parent's delivery roots", () => {
    const base = resolveSandbox({ mode: "workspace-write" }, parentCwd);
    const { deliveryRoots } = resolveWorktreeRoots({
      worktreePath: worktree,
      baseSandbox: base,
      parentDeliveryRoots: [parentCwd, "/some/delivery"],
    });
    expect(deliveryRoots).toEqual([worktree, parentCwd, "/some/delivery"]);
  });

  it("does not duplicate the worktree if already a delivery root", () => {
    const base = resolveSandbox({ mode: "workspace-write" }, parentCwd);
    const { deliveryRoots } = resolveWorktreeRoots({
      worktreePath: worktree,
      baseSandbox: base,
      parentDeliveryRoots: [worktree, parentCwd],
    });
    expect(deliveryRoots).toEqual([worktree, parentCwd]);
  });

  it("re-anchors even under a non-temp worktree path (the fragile case)", () => {
    // This is the whole point: a worktree NOT under the OS tmpdir would not be
    // covered by defaultTempWritableRoots, so the explicit root is what makes
    // a worker's writes to its own checkout land.
    const base = resolveSandbox({ mode: "workspace-write" }, parentCwd);
    const nonTemp = "/var/lib/agent-worktrees/wt-1/project";
    const { sandbox } = resolveWorktreeRoots({
      worktreePath: nonTemp,
      baseSandbox: base,
      parentDeliveryRoots: [],
    });
    expect(sandbox.writableRoots).toContain(nonTemp);
  });
});
