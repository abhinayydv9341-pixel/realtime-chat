'use strict';

const os = require('os');

const DEV_SECRET = 'dev-secret-change-me';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
}

function loadConfig(overrides = {}) {
  const config = {
    port: num('PORT', 3000),
    databaseUrl: process.env.DATABASE_URL || 'postgres://chat:chat@localhost:5432/chat',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    jwtSecret: process.env.JWT_SECRET || DEV_SECRET,
    jwtTtlSeconds: num('JWT_TTL_SECONDS', 24 * 60 * 60),
    bcryptRounds: num('BCRYPT_ROUNDS', 10),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    instanceId: process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}`,
    presenceTtlMs: num('PRESENCE_TTL_MS', 60_000),
    rateLimit: {
      messages: num('MESSAGE_RATE_LIMIT', 10),
      windowMs: num('MESSAGE_RATE_WINDOW_MS', 10_000),
    },
    ...overrides,
  };

  if (process.env.NODE_ENV === 'production' && config.jwtSecret === DEV_SECRET) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return config;
}

module.exports = { loadConfig };
