'use strict';

/**
 * Two independent server processes' worth of state (separate HTTP servers, pg pools and
 * Redis connections) sharing one Postgres and one Redis. Clients on different instances
 * must still see each other's messages and presence: that's the Redis pub/sub fan-out.
 */

const request = require('supertest');
const Redis = require('ioredis');
const { PresenceTracker } = require('../src/realtime/presence');
const { loadConfig } = require('../src/config');
const { startServer, resetState, registerUser, connectSocket, waitFor, emitAck } = require('./helpers');

let a;
let b;
const sockets = [];
beforeAll(async () => {
  [a, b] = await Promise.all([startServer({ instanceId: 'A' }), startServer({ instanceId: 'B' })]);
});
afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});
beforeEach(resetState);
afterEach(async () => {
  while (sockets.length) sockets.pop().close();
  // let server-side disconnect handlers settle before the next test wipes state
  await new Promise((r) => setTimeout(r, 150));
});

async function connect(server, user) {
  const socket = await connectSocket(server, user.token);
  sockets.push(socket);
  return socket;
}

describe('horizontal scaling', () => {
  test('instances identify themselves', async () => {
    expect((await request(a.app).get('/healthz')).body.instance).toBe('A');
    expect((await request(b.app).get('/healthz')).body.instance).toBe('B');
  });

  test('a message sent on instance B reaches a client connected to instance A', async () => {
    const alice = await registerUser(a);
    const bob = await registerUser(b);
    const { body } = await request(a.app).post('/api/rooms').set('Authorization', alice.auth).send({ name: 'x' });
    await request(b.app).post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth);

    const onA = await connect(a, alice);
    const onB = await connect(b, bob);
    const received = waitFor(onA, 'message:new');
    const ack = await emitAck(onB, 'message:send', { roomId: body.room.id, body: 'across instances' });
    expect(ack.ok).toBe(true);
    expect(await received).toEqual(ack.message);
  });

  test('a REST post on one instance fans out to sockets on the other', async () => {
    const alice = await registerUser(a);
    const bob = await registerUser(a);
    const { body } = await request(a.app).post('/api/rooms').set('Authorization', alice.auth).send({ name: 'x' });
    await request(a.app).post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth);

    const bobOnB = await connect(b, bob);
    const received = waitFor(bobOnB, 'message:new');
    await request(a.app).post(`/api/rooms/${body.room.id}/messages`).set('Authorization', alice.auth).send({ body: 'hi' });
    expect((await received).body).toBe('hi');
  });

  test('joining a room via instance A subscribes the user’s socket on instance B', async () => {
    const alice = await registerUser(a);
    const bob = await registerUser(a);
    const { body } = await request(a.app).post('/api/rooms').set('Authorization', alice.auth).send({ name: 'x' });

    const bobOnB = await connect(b, bob);
    const joined = waitFor(bobOnB, 'room:joined');
    await request(a.app).post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth);
    await joined;

    const received = waitFor(bobOnB, 'message:new');
    await request(a.app).post(`/api/rooms/${body.room.id}/messages`).set('Authorization', alice.auth).send({ body: 'yo' });
    expect((await received).body).toBe('yo');
  });

  test('presence is cluster-wide: a user with tabs on both instances stays online until both close', async () => {
    const alice = await registerUser(a);
    const bob = await registerUser(a);
    const watcher = await connect(a, bob);

    const tabA = await connect(a, alice);
    const tabB = await connect(b, alice);
    tabA.close();
    await new Promise((r) => setTimeout(r, 300));
    expect((await request(b.app).get(`/api/presence/${alice.id}`).set('Authorization', bob.auth)).body.online).toBe(true);

    const offline = waitFor(watcher, 'presence:update', (p) => p.userId === alice.id && !p.online);
    tabB.close();
    await offline;
  });

  test('logout on instance A disconnects the session’s socket on instance B', async () => {
    const alice = await registerUser(a);
    const onB = await connect(b, alice);
    const disconnected = waitFor(onB, 'disconnect');
    await request(a.app).post('/api/auth/logout').set('Authorization', alice.auth);
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('presence leases', () => {
  test('sockets of a crashed instance expire instead of staying online forever', async () => {
    const redis = new Redis(loadConfig().redisUrl);
    const presence = new PresenceTracker(redis, { ttlMs: 1000 });
    const t0 = Date.now();
    await presence.connect(7, 'socket-on-dead-instance', t0);
    expect(await presence.onlineUserIds(t0 + 500)).toEqual([7]);
    // No heartbeat and no disconnect: the instance died.
    expect(await presence.onlineUserIds(t0 + 1500)).toEqual([]);
    expect(await presence.isOnline(7, t0 + 1500)).toBe(false);
    await redis.quit();
  });
});
