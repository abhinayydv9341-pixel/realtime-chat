'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const Redis = require('ioredis');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { SlidingWindowRateLimiter } = require('./lib/rateLimiter');
const { createAuthService } = require('./services/auth');
const { createRoomService } = require('./services/rooms');
const { createMessageService } = require('./services/messages');
const { PresenceTracker } = require('./realtime/presence');
const { attachSocketHandlers, createRealtimeFacade } = require('./realtime/socket');
const { createRouter } = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware');

const defaultLog = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

/**
 * Builds one chat server instance. Any number of instances can run against the same
 * Postgres + Redis: Socket.IO's Redis adapter relays broadcasts between them over pub/sub.
 */
async function createServer(overrides = {}, { log = defaultLog } = {}) {
  const config = loadConfig(overrides);

  const db = createPool(config.databaseUrl);
  await migrate(db);

  const redis = new Redis(config.redisUrl);
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();

  const auth = createAuthService({ db, config });
  const rooms = createRoomService({ db });
  const messages = createMessageService({ db, rooms });
  const presence = new PresenceTracker(redis, { ttlMs: config.presenceTtlMs });
  const limiter = new SlidingWindowRateLimiter(redis, {
    limit: config.rateLimit.messages,
    windowMs: config.rateLimit.windowMs,
  });

  let io;
  const realtime = createRealtimeFacade(() => io);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/healthz', async (req, res) => {
    try {
      await Promise.all([db.query('SELECT 1'), redis.ping()]);
      res.json({ status: 'ok', instance: config.instanceId });
    } catch {
      res.status(503).json({ status: 'unavailable', instance: config.instanceId });
    }
  });
  app.use('/api', createRouter({ auth, rooms, messages, presence, limiter, realtime }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(notFoundHandler);
  app.use(errorHandler(log));

  // The HTTP server must be created with the Express app *before* Socket.IO attaches,
  // so Socket.IO can route /socket.io/ requests ahead of Express.
  const httpServer = http.createServer(app);
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin },
    adapter: createAdapter(pubClient, subClient),
  });
  attachSocketHandlers(io, { auth, rooms, messages, presence, limiter, log });

  // Keep presence leases of this instance's sockets alive.
  const heartbeat = setInterval(() => {
    const entries = [];
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.user) entries.push({ userId: socket.data.user.id, socketId: socket.id });
    }
    presence.heartbeat(entries).catch((err) => log.error('presence heartbeat failed', err));
  }, Math.max(1000, Math.floor(config.presenceTtlMs / 3)));
  heartbeat.unref();

  return {
    config,
    app,
    io,
    httpServer,
    db,
    redis,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => resolve(httpServer.address().port));
      });
    },
    async close() {
      clearInterval(heartbeat);
      await new Promise((resolve) => io.close(() => resolve()));
      await Promise.allSettled([redis.quit(), pubClient.quit(), subClient.quit()]);
      await db.end();
    },
  };
}

module.exports = { createServer };
