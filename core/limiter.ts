export interface Bucket {
  limit: number;
  ceiling: number;
  until: number;
  epoch: number;
  stableSince: number;
  reason?: string;
}
export interface RateTicket {
  account: number;
  connection: number;
  project: number;
}

// Shared by every request using this AuthService, including reads outside tasks.
export class AdaptiveLimits {
  private buckets = new Map<string, Bucket>();
  constructor(private now = () => Date.now()) {}
  bucket(key: string, ceiling: number) {
    ceiling = Math.max(1, ceiling);
    let b = this.buckets.get(key);
    if (!b) {
      b = { limit: ceiling, ceiling, until: 0, epoch: 0, stableSince: this.now() };
      this.buckets.set(key, b);
    } else {
      if (b.ceiling !== ceiling) {
        b.limit = b.limit === b.ceiling ? ceiling : Math.min(b.limit, ceiling);
        b.ceiling = ceiling;
      }
      if (b.limit < ceiling && this.now() >= Math.max(b.until, b.stableSince) + 60000) {
        const levels = [ceiling];
        while (levels.at(-1)! > 1) levels.push(Math.max(1, Math.floor(levels.at(-1)! / 2)));
        b.limit = [...levels].reverse().find((n) => n > b!.limit) || ceiling;
        b.stableSince = this.now();
        b.epoch++;
      }
    }
    return b;
  }
  reduce(key: string, ceiling: number, issuedEpoch: number, wait: number, reason: string) {
    const b = this.bucket(key, ceiling),
      now = this.now();
    if (issuedEpoch === b.epoch) {
      b.limit = Math.max(1, Math.floor(b.limit / 2));
      b.epoch++;
    }
    b.until = Math.max(b.until, now + wait);
    b.stableSince = Math.max(b.stableSince, b.until);
    b.reason = reason;
    return b;
  }
}
