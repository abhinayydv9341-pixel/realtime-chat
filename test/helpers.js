'use strict';

const request = require('supertest');
const { io: connectClient } = require('socket.io-client');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/config');

const silentLog = { info: () => {}, error: () => {} };

async function startServer(overrides = {}) {
  const server = await createServer(
    {
      bcryptRounds: 4,
      rateLimit: { messages: 5, windowMs: 2000 },
      presenceTtlMs: 5000,
      ...overrides,
    },
    { log: silentLog },
  );
  const port = await server.listen(0);
  return { ...server, url: `http://127.0.0.1:${port}` };
}

/** Wipes Postgres tables and the Redis db between tests. */
async function resetState() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  await pool.query('TRUNCATE messages, room_members, rooms, sessions, users RESTART IDENTITY CASCADE');
  await pool.end();
  const redis = new Redis(config.redisUrl);
  await redis.flushdb();
  await redis.quit();
}

let userCounter = 0;
async function registerUser(server, username = `user_${++userCounter}`) {
  const res = await request(server.app).post('/api/auth/register').send({ username, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.token, auth: `Bearer ${res.body.token}` };
}

/** Connects a socket and resolves once the server says its rooms are joined. */
function connectSocket(server, token) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(server.url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    socket.once('session:ready', (info) => {
      clearTimeout(timer);
      socket.info = info;
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });
}

/** Resolves with the first `event` payload matching `predicate`. */
function waitFor(socket, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function listener(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    }
    socket.on(event, listener);
  });
}

/** Resolves true if `event` is NOT received within `ms`. */
function expectSilence(socket, event, ms = 400) {
  return new Promise((resolve, reject) => {
    const listener = (payload) => {
      clearTimeout(timer);
      reject(new Error(`unexpected ${event}: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve(true);
    }, ms);
    socket.on(event, listener);
  });
}

function emitAck(socket, event, payload) {
  return socket.timeout(3000).emitWithAck(event, payload);
}

module.exports = { startServer, resetState, registerUser, connectSocket, waitFor, expectSilence, emitAck };
