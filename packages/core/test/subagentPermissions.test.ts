// #13: a built-in sub-agent (explore/worker, no custom permissionMode) shared
// the parent's live PermissionEngine by default, so an allow rule the user
// approved mid-session carried into the sub-agent with no isolation boundary.
// `resolveSubagentPermissions` makes the inherit-vs-independent choice explicit:
// default "inherit" keeps today's behavior; "independent" (or a custom agent's
// own permissionMode) gives the sub-agent a fresh engine.

import { describe, expect, it } from "vitest";
import { resolveSubagentPermissions } from "../src/subagent.js";
import { PermissionEngine } from "../src/permissions.js";

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
