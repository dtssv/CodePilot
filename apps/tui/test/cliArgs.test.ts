// Tests for the --profile / --config-patch CLI flags and the bundle
// subcommand argv parsing added in #28.

import { describe, expect, it } from "vitest";
import { parseArgs, parseConfigPatch } from "../src/cli.js";

describe("parseArgs: --profile", () => {
  it("parses '--profile <name>' (space-separated)", () => {
    const args = parseArgs(["--profile", "prod"]);
    expect(args.profile).toBe("prod");
  });

  it("parses '--profile=<name>' (equals form)", () => {
    const args = parseArgs(["--profile=dev"]);
    expect(args.profile).toBe("dev");
  });

  it("is undefined when the flag is absent", () => {
    expect(parseArgs([]).profile).toBeUndefined();
  });

  it("coexists with other flags and a positional prompt", () => {
    const args = parseArgs([
      "--model", "gpt-4o",
      "--profile", "prod",
      "--yolo",
      "fix", "the", "tests",
    ]);
    expect(args.profile).toBe("prod");
    expect(args.model).toBe("gpt-4o");
    expect(args.yolo).toBe(true);
    expect(args.prompt).toBe("fix the tests");
  });
});

describe("parseArgs: --config-patch", () => {
  it("parses a JSON patch (space-separated)", () => {
    const args = parseArgs([
      "--config-patch",
      '{"model":"gpt-4o","permissionMode":"yolo"}',
    ]);
    expect(args.configPatch).toBe('{"model":"gpt-4o","permissionMode":"yolo"}');
  });

  it("parses --config-patch=<json> (equals form)", () => {
    const args = parseArgs(['--config-patch={"maxTurns":10}']);
    expect(args.configPatch).toBe('{"maxTurns":10}');
  });

  it("is undefined when the flag is absent", () => {
    expect(parseArgs([]).configPatch).toBeUndefined();
  });
});

describe("parseConfigPatch", () => {
  it("parses a valid object patch", () => {
    expect(parseConfigPatch('{"model":"gpt-4o","permissionMode":"yolo"}')).toEqual({
      model: "gpt-4o",
      permissionMode: "yolo",
    });
  });

  it("supports nested objects and null deletions", () => {
    expect(parseConfigPatch('{"sandbox":{"network":false},"model":null}')).toEqual({
      sandbox: { network: false },
      model: null,
    });
  });

  it("throws a friendly error on malformed JSON", () => {
    expect(() => parseConfigPatch("{ not json")).toThrow(
      /--config-patch is not valid JSON/
    );
  });

  it("rejects non-object JSON (arrays, scalars, null)", () => {
    expect(() => parseConfigPatch('[1,2]')).toThrow(/must be a JSON object/);
    expect(() => parseConfigPatch('"str"')).toThrow(/must be a JSON object/);
    expect(() => parseConfigPatch("null")).toThrow(/must be a JSON object/);
  });
});

describe("parseArgs: bundle subcommand", () => {
  it("captures 'bundle export [path]' as a subcommand", () => {
    const args = parseArgs(["bundle", "export", "./my-bundle.json"]);
    expect(args.subcommand).toBe("bundle");
    expect(args.subcommandArgs).toEqual(["export", "./my-bundle.json"]);
  });

  it("captures 'bundle import <path>'", () => {
    const args = parseArgs(["bundle", "import", "./b.json"]);
    expect(args.subcommand).toBe("bundle");
    expect(args.subcommandArgs).toEqual(["import", "./b.json"]);
  });

  it("bundle export with no path leaves the default to the handler", () => {
    const args = parseArgs(["bundle", "export"]);
    expect(args.subcommand).toBe("bundle");
    expect(args.subcommandArgs).toEqual(["export"]);
  });

  it("does not treat arbitrary positionals as subcommands", () => {
    const args = parseArgs(["refactor", "the", "config"]);
    expect(args.subcommand).toBeUndefined();
    expect(args.prompt).toBe("refactor the config");
  });

  it("parses global flags that appear after the subcommand args", () => {
    const args = parseArgs([
      "bundle", "export", "./out.json",
      "--profile", "prod",
      "--config-patch", '{"maxTurns":33}',
    ]);
    expect(args.subcommand).toBe("bundle");
    expect(args.subcommandArgs).toEqual(["export", "./out.json"]);
    expect(args.profile).toBe("prod");
    expect(args.configPatch).toBe('{"maxTurns":33}');
  });

  it("supports --flag=value form after the subcommand", () => {
    const args = parseArgs(["bundle", "export", "--profile=dev"]);
    expect(args.subcommandArgs).toEqual(["export"]);
    expect(args.profile).toBe("dev");
  });
});
