interface RateLimitConfig {
  windowMs: number;
  max: number;
}

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
// Note: This is per-instance. In a serverless environment like Vercel,
// this will only limit requests hitting the same warm instance.
// For strict global rate limiting, use Redis (Vercel KV).
const hits = new Map<string, RateLimitInfo>();

// Cleanup expired entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of hits.entries()) {
    if (now > info.resetTime) {
      hits.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function rateLimit(ip: string, config: RateLimitConfig): { success: boolean; limit: number; remaining: number; reset: number } {
  const now = Date.now();
  const info = hits.get(ip) || { count: 0, resetTime: now + config.windowMs };

  // If window has expired, reset
  if (now > info.resetTime) {
    info.count = 0;
    info.resetTime = now + config.windowMs;
  }

  info.count++;
  hits.set(ip, info);

  const remaining = Math.max(0, config.max - info.count);

  return {
    success: info.count <= config.max,
    limit: config.max,
    remaining,
    reset: Math.ceil((info.resetTime - now) / 1000),
  };
}
