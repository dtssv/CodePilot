import { describe, expect, it } from "vitest";

import {
  buildOrphanLaunch,
  shellQuoteUnix,
  shellQuoteWin,
} from "../src/orphanDaemon.js";

describe("shellQuoteUnix", () => {
  it("wraps in single quotes and escapes embedded quotes", () => {
    expect(shellQuoteUnix("a")).toBe("'a'");
    expect(shellQuoteUnix("a b")).toBe("'a b'");
    expect(shellQuoteUnix("it's")).toBe("'it'\\''s'");
  });
});

describe("shellQuoteWin", () => {
  it("quotes when needed", () => {
    expect(shellQuoteWin("codepilot")).toBe("codepilot");
    expect(shellQuoteWin("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(shellQuoteWin("")).toBe('""');
  });
});

describe("buildOrphanLaunch", () => {
  it("unix uses /bin/sh -c background", () => {
    const launch = buildOrphanLaunch(
      "/usr/bin/codepilot",
      ["serve", "--daemon", "--port", "18765"],
      "darwin",
    );
    expect(launch.cmd).toBe("/bin/sh");
    expect(launch.args).toEqual([
      "-c",
      "'/usr/bin/codepilot' 'serve' '--daemon' '--port' '18765' >/dev/null 2>&1 &",
    ]);
  });

  it("win32 uses cmd start /b", () => {
    const launch = buildOrphanLaunch("codepilot", ["serve", "--daemon"], "win32");
    expect(launch.args[0]).toBe("/d");
    expect(launch.args[2]).toBe("/c");
    expect(launch.args[3]).toBe('start "" /b codepilot serve --daemon');
  });
});
