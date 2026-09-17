// Minimal mock of the `vscode` module for unit tests.
//
// The real `vscode` module only exists inside the VSCode extension host, so
// under vitest we substitute this stub via the `test.alias` entry in
// vitest.config.ts. It implements just the API surface our extension code
// touches (workspace config, status bar, commands, Uri, Disposable), with a
// mutable configuration store so tests can simulate settings changes.

export interface MockConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

type ConfigurationChangeListener = (e: MockConfigurationChangeEvent) => void;

/** In-memory backing store for workspace configuration, keyed by full
 *  section path (e.g. "codepilot.serverPath"). Tests mutate this via
 *  `__setConfig` / `__resetConfig`. */
const configStore = new Map<string, unknown>();

export function __setConfig(key: string, value: unknown): void {
  configStore.set(key, value);
}

export function __resetConfig(values: Record<string, unknown> = {}): void {
  configStore.clear();
  for (const [k, v] of Object.entries(values)) configStore.set(k, v);
}

/** Fire the registered onDidChangeConfiguration listeners, pretending the
 *  given section changed. */
export function __fireConfigChange(section = "codepilot"): void {
  const e: MockConfigurationChangeEvent = {
    affectsConfiguration: (s: string) => section === s || section.startsWith(`${s}.`),
  };
  for (const l of configChangeListeners) l(e);
}

const configChangeListeners = new Set<ConfigurationChangeListener>();

export class Disposable {
  private readonly fn: () => void;
  constructor(fn: () => void) {
    this.fn = fn;
  }
  dispose(): void {
    this.fn();
  }
  static from(...disposables: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }
}

export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

class MockWorkspaceConfiguration implements WorkspaceConfiguration {
  constructor(private readonly section: string) {}
  get<T>(key: string, defaultValue: T): T {
    // The extension passes full keys (e.g. "codepilot.serverPath") even when
    // the configuration object was created for the "codepilot" section, so
    // honor full keys verbatim and fall back to section-relative lookup.
    const full = key.startsWith(`${this.section}.`) ? key : `${this.section}.${key}`;
    const v = configStore.get(full);
    return (v === undefined ? defaultValue : v) as T;
  }
}

/** Workspace folders exposed via `workspace.workspaceFolders`. Tests set
 *  this to control the cwd passed to the server. */
export let __workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined = undefined;
export function __setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined): void {
  __workspaceFolders = folders;
}

export const workspace = {
  getConfiguration(section?: string): WorkspaceConfiguration {
    return new MockWorkspaceConfiguration(section ?? "");
  },
  onDidChangeConfiguration(listener: ConfigurationChangeListener): Disposable {
    configChangeListeners.add(listener);
    return new Disposable(() => configChangeListeners.delete(listener));
  },
  get workspaceFolders() {
    return __workspaceFolders;
  },
};

/* ---------------- status bar ---------------- */

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** Every status bar item created through the mock, so tests can inspect the
 *  last-rendered text without spying on the factory. */
export const __statusBarItems: StatusBarItem[] = [];

export const window = {
  createStatusBarItem(_alignment?: StatusBarAlignment, _priority?: number): StatusBarItem {
    const item: StatusBarItem = {
      text: "",
      tooltip: undefined,
      command: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };
    __statusBarItems.push(item);
    return item;
  },
};

/* ---------------- commands ---------------- */

/** Recorded executeCommand invocations: [command, ...args]. */
export const __executedCommands: Array<{ command: string; args: unknown[] }> = [];

export function __resetCommands(): void {
  __executedCommands.length = 0;
}

export const commands = {
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    __executedCommands.push({ command, args });
    return undefined;
  },
};

/* ---------------- Uri ---------------- */

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }
  static file(path: string): Uri {
    return new Uri("file", path);
  }
  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.fsPath, ...pathSegments].join("/").replace(/\/+/g, "/");
    return new Uri(base.scheme, joined);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

/* ---------------- misc ---------------- */

/** Reset all mock state between tests. */
export function __resetAll(): void {
  __resetConfig();
  __setWorkspaceFolders(undefined);
  __statusBarItems.length = 0;
  __resetCommands();
  configChangeListeners.clear();
}
