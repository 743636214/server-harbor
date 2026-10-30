export function createLimiter({ maxKeys = 10000, windowMs = 300000 } = {}) {
  const buckets = new Map();
  return {
    take(key, limit) {
      const now = Date.now();
      for (const [name, value] of buckets) if (value.until <= now) buckets.delete(name);
      let bucket = buckets.get(key);
      if (!bucket) {
        // Fail closed instead of evicting the attacker's existing limit.
        if (buckets.size >= maxKeys) return false;
        bucket = { count: 0, until: now + windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count >= limit) return false;
      bucket.count++;
      return true;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
