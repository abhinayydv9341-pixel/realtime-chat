'use strict';

const crypto = require('crypto');

/**
 * Sliding-window rate limiter backed by a Redis sorted set (one member per event,
 * scored by timestamp). Because state lives in Redis, the limit holds across every
 * server instance, not per process.
 */
class SlidingWindowRateLimiter {
  constructor(redis, { limit, windowMs, prefix = 'ratelimit' }) {
    this.redis = redis;
    this.limit = limit;
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  async consume(key, now = Date.now()) {
    const redisKey = `${this.prefix}:${key}`;
    const member = `${now}:${crypto.randomUUID()}`;

    const results = await this.redis
      .multi()
      .zremrangebyscore(redisKey, 0, now - this.windowMs)
      .zadd(redisKey, now, member)
      .zcard(redisKey)
      .zrange(redisKey, 0, 0, 'WITHSCORES')
      .pexpire(redisKey, this.windowMs)
      .exec();

    for (const [err] of results) if (err) throw err;
    const count = results[2][1];

    if (count > this.limit) {
      // Rejected attempts don't consume quota.
      await this.redis.zrem(redisKey, member);
      const oldest = Number(results[3][1][1]);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, oldest + this.windowMs - now) };
    }
    return { allowed: true, remaining: this.limit - count, retryAfterMs: 0 };
  }
}

module.exports = { SlidingWindowRateLimiter };
