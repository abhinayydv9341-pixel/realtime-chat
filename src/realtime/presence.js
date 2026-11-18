'use strict';

/**
 * Cluster-wide presence stored in Redis.
 *
 *   presence:user:<id>  sorted set of socket ids, scored by lease expiry (ms)
 *   presence:users      set of user ids that may be online
 *
 * A user is online while at least one socket lease is unexpired. Each instance refreshes
 * the leases of its own sockets on a heartbeat, so if an instance dies without cleaning up,
 * its sockets expire after `ttlMs` instead of leaving users stuck "online" forever.
 */

const CONNECT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[5])
return before
`;

const DISCONNECT_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local remaining = redis.call('ZCARD', KEYS[1])
if remaining == 0 then
  redis.call('SREM', KEYS[2], ARGV[3])
end
return remaining
`;

const USERS_KEY = 'presence:users';
const userKey = (userId) => `presence:user:${userId}`;

class PresenceTracker {
  constructor(redis, { ttlMs = 60_000 } = {}) {
    this.redis = redis;
    this.ttlMs = ttlMs;
    if (!redis.presenceConnect) {
      redis.defineCommand('presenceConnect', { numberOfKeys: 2, lua: CONNECT_SCRIPT });
      redis.defineCommand('presenceDisconnect', { numberOfKeys: 2, lua: DISCONNECT_SCRIPT });
    }
  }

  /** Registers a socket. Resolves true if this made the user go from offline to online. */
  async connect(userId, socketId, now = Date.now()) {
    const before = await this.redis.presenceConnect(
      userKey(userId),
      USERS_KEY,
      now,
      now + this.ttlMs,
      socketId,
      this.ttlMs * 2,
      userId,
    );
    return before === 0;
  }

  /** Removes a socket. Resolves true if the user has no sockets left anywhere in the cluster. */
  async disconnect(userId, socketId, now = Date.now()) {
    const remaining = await this.redis.presenceDisconnect(userKey(userId), USERS_KEY, now, socketId, userId);
    return remaining === 0;
  }

  /** Extends the lease of sockets owned by this instance. */
  async heartbeat(entries, now = Date.now()) {
    if (entries.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const { userId, socketId } of entries) {
      pipeline.zadd(userKey(userId), 'XX', now + this.ttlMs, socketId);
      pipeline.pexpire(userKey(userId), this.ttlMs * 2);
    }
    await pipeline.exec();
  }

  async isOnline(userId, now = Date.now()) {
    return (await this.redis.zcount(userKey(userId), now, '+inf')) > 0;
  }

  async onlineUserIds(now = Date.now()) {
    const candidates = await this.redis.smembers(USERS_KEY);
    if (candidates.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of candidates) pipeline.zcount(userKey(id), now, '+inf');
    const counts = await pipeline.exec();

    const online = [];
    const stale = [];
    candidates.forEach((id, i) => (counts[i][1] > 0 ? online : stale).push(id));
    // Users whose every lease expired (crashed instance) are lazily dropped from the index.
    if (stale.length) await this.redis.srem(USERS_KEY, ...stale);
    return online.map(Number).sort((a, b) => a - b);
  }
}

module.exports = { PresenceTracker };
