export interface GitDiffResult { diff: string; truncated: boolean }
export interface GitDiffState extends GitDiffResult {
  path: string;
  staged: boolean;
  loading: boolean;
  error: string | null;
}

/** Latest request wins; closing/unmounting invalidates pending responses. */
export class GitDiffController {
  private revision = 0;
  constructor(
    private readonly fetchDiff: (path: string, staged: boolean) => Promise<GitDiffResult>,
    private readonly publish: (state: GitDiffState | null) => void,
  ) {}

  async load(path: string, staged: boolean): Promise<void> {
    const revision = ++this.revision;
    const base = { path, staged, diff: "", truncated: false, error: null };
    this.publish({ ...base, loading: true });
    try {
      const result = await this.fetchDiff(path, staged);
      if (revision === this.revision) this.publish({ ...base, ...result, loading: false });
    } catch (error) {
      if (revision === this.revision) this.publish({
        ...base, loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  invalidate(): void { this.revision++; }
  close(): void { this.invalidate(); this.publish(null); }
}
