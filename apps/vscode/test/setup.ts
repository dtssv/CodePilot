import { beforeEach } from "vitest";
import * as vscodeMock from "./__mocks__/vscode.js";

// Reset the vscode mock's mutable state before every test so suites stay
// independent even though they share one module instance.
beforeEach(() => {
  vscodeMock.__resetAll();
});
