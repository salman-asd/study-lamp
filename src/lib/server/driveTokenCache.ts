export interface LoadedDriveToken {
  token: string;
  expiresAt: number;
}

interface CachedDriveToken extends LoadedDriveToken {}

export class DriveTokenCache {
  private readonly tokens = new Map<string, CachedDriveToken>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly maxEntries = 500,
    private readonly refreshBufferMs = 60_000,
  ) {}

  async get(key: string, load: () => Promise<LoadedDriveToken>, now = Date.now()): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.refreshBufferMs > now) {
      this.tokens.delete(key);
      this.tokens.set(key, cached);
      return cached.token;
    }
    if (cached) this.tokens.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const generation = this.generations.get(key) ?? 0;
    const request = load().then(({ token, expiresAt }) => {
      if (generation === (this.generations.get(key) ?? 0) && expiresAt > now) {
        this.tokens.delete(key);
        this.tokens.set(key, { token, expiresAt });
        while (this.tokens.size > this.maxEntries) {
          const oldestKey = this.tokens.keys().next().value;
          if (oldestKey === undefined) break;
          this.tokens.delete(oldestKey);
        }
      }
      return token;
    }).finally(() => {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
        this.generations.delete(key);
      } else if (!this.inFlight.has(key)) {
        this.generations.delete(key);
      }
    });

    this.inFlight.set(key, request);
    return request;
  }

  invalidate(key: string): void {
    this.tokens.delete(key);
    if (this.inFlight.has(key)) {
      this.inFlight.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    } else {
      this.generations.delete(key);
    }
  }

  clear(): void {
    this.tokens.clear();
    this.inFlight.clear();
    this.generations.clear();
  }
}