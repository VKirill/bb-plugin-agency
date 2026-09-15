export const WEBHOOK_RATE_PER_MINUTE = 60;
export const WEBHOOK_RATE_BURST = 10;
export const WEBHOOK_RATE_KNOWN_BUCKET_CAP = 64;
export const WEBHOOK_UNKNOWN_BUCKET = "_unknown";

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

type Bucket = { tokens: number; updatedAtMs: number };

function refill(bucket: Bucket, now: number, burst: number, refillPerMinute: number): number {
  const elapsedMin = Math.max(0, now - bucket.updatedAtMs) / 60_000;
  return Math.min(burst, bucket.tokens + elapsedMin * refillPerMinute);
}

/** Process-local token buckets. Known keys are resolved source ids only. Unknown share one bucket. */
export function createWebhookRateLimiter(input: {
  nowMs: () => number;
  burst?: number;
  refillPerMinute?: number;
  knownBucketCap?: number;
}) {
  const burst = input.burst ?? WEBHOOK_RATE_BURST;
  const refillPerMinute = input.refillPerMinute ?? WEBHOOK_RATE_PER_MINUTE;
  const knownCap = input.knownBucketCap ?? WEBHOOK_RATE_KNOWN_BUCKET_CAP;
  const known = new Map<string, Bucket>();
  let unknown: Bucket = { tokens: burst, updatedAtMs: input.nowMs() };

  function consume(bucket: Bucket, now: number): RateLimitDecision {
    const tokens = refill(bucket, now, burst, refillPerMinute);
    if (tokens < 1) {
      bucket.tokens = tokens;
      bucket.updatedAtMs = now;
      const waitMs = ((1 - tokens) / refillPerMinute) * 60_000;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    bucket.tokens = tokens - 1;
    bucket.updatedAtMs = now;
    return { ok: true };
  }

  function evictOldestKnown() {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of known) {
      if (bucket.updatedAtMs < oldestAt) {
        oldestAt = bucket.updatedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey) known.delete(oldestKey);
  }

  return {
    takeKnown(sourceId: string): RateLimitDecision {
      const now = input.nowMs();
      let bucket = known.get(sourceId);
      if (!bucket) {
        if (known.size >= knownCap) evictOldestKnown();
        bucket = { tokens: burst, updatedAtMs: now };
        known.set(sourceId, bucket);
      }
      return consume(bucket, now);
    },
    takeUnknown(): RateLimitDecision {
      return consume(unknown, input.nowMs());
    },
    knownBucketCount(): number {
      return known.size;
    },
  };
}

export type WebhookRateLimiter = ReturnType<typeof createWebhookRateLimiter>;
