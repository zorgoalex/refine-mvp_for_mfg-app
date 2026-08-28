export const FRONTEND_VERSION_CHECK_INTERVAL_MS = 60_000;

export interface FrontendVersionMonitorOptions {
  currentSha: string;
  readLatestSha: () => Promise<string | null>;
  onVersionAvailable: (latestSha: string) => void;
  intervalMs?: number;
  startedAt?: number;
}

export class FrontendVersionMonitor {
  private readonly currentSha: string;
  private readonly readLatestSha: () => Promise<string | null>;
  private readonly onVersionAvailable: (latestSha: string) => void;
  private readonly intervalMs: number;
  private lastCheckedAt: number;
  private inFlight: Promise<void> | null = null;
  private versionAvailable = false;

  constructor(options: FrontendVersionMonitorOptions) {
    this.currentSha = options.currentSha;
    this.readLatestSha = options.readLatestSha;
    this.onVersionAvailable = options.onVersionAvailable;
    this.intervalMs = options.intervalMs ?? FRONTEND_VERSION_CHECK_INTERVAL_MS;
    this.lastCheckedAt = options.startedAt ?? Date.now();
  }

  check(now = Date.now(), visible = true): Promise<void> {
    if (!visible || this.versionAvailable) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (now - this.lastCheckedAt < this.intervalMs) return Promise.resolve();

    this.lastCheckedAt = now;
    this.inFlight = this.readLatestSha()
      .then((latestSha) => {
        if (!latestSha || latestSha === this.currentSha || this.versionAvailable) return;
        this.versionAvailable = true;
        this.onVersionAvailable(latestSha);
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
