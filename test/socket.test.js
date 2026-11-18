'use strict';

const request = require('supertest');
const { startServer, resetState, registerUser, connectSocket, waitFor, expectSilence, emitAck } = require('./helpers');

let server;
const sockets = [];
beforeAll(async () => {
  server = await startServer({ rateLimit: { messages: 3, windowMs: 2000 } });
});
afterAll(() => server.close());
beforeEach(resetState);
afterEach(async () => {
  while (sockets.length) sockets.pop().close();
  // let server-side disconnect handlers settle before the next test wipes state
  await new Promise((r) => setTimeout(r, 150));
});

const api = () => request(server.app);
async function connect(user) {
  const socket = await connectSocket(server, user.token);
  sockets.push(socket);
  return socket;
}
async function createRoom(owner, ...members) {
  const { body } = await api().post('/api/rooms').set('Authorization', owner.auth).send({ name: 'general' });
  for (const m of members) await api().post(`/api/rooms/${body.room.id}/join`).set('Authorization', m.auth);
  return body.room;
}

describe('socket connection', () => {
  test('connections without a valid token are refused', async () => {
    await expect(connectSocket(server, undefined)).rejects.toThrow('unauthorized');
    await expect(connectSocket(server, 'not-a-jwt')).rejects.toThrow('unauthorized');
  });

  test('session:ready lists the rooms the user belongs to', async () => {
    const alice = await registerUser(server);
    const room = await createRoom(alice);
    const socket = await connect(alice);
    expect(socket.info.user.id).toBe(alice.id);
    expect(socket.info.roomIds).toEqual([room.id]);
  });

  test('logging out disconnects that session’s sockets', async () => {
    const alice = await registerUser(server);
    const socket = await connect(alice);
    const disconnected = waitFor(socket, 'disconnect');
    await api().post('/api/auth/logout').set('Authorization', alice.auth);
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('real-time messaging', () => {
  test('a message sent over the socket is acked and broadcast to room members only', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const eve = await registerUser(server);
    const room = await createRoom(alice, bob);
    const [sa, sb, se] = await Promise.all([connect(alice), connect(bob), connect(eve)]);

    const bobGets = waitFor(sb, 'message:new');
    const eveSilent = expectSilence(se, 'message:new');
    const ack = await emitAck(sa, 'message:send', { roomId: room.id, body: 'hello bob' });

    expect(ack.ok).toBe(true);
    expect(ack.message).toMatchObject({ body: 'hello bob', senderId: alice.id });
    expect(await bobGets).toEqual(ack.message);
    await eveSilent;

    // ...and it was persisted.
    const history = await api().get(`/api/rooms/${room.id}/messages`).set('Authorization', bob.auth);
    expect(history.body.messages[0].id).toBe(ack.message.id);
  });

  test('messages posted over REST are pushed to connected sockets', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const room = await createRoom(alice, bob);
    const sb = await connect(bob);
    const received = waitFor(sb, 'message:new');
    await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: 'via rest' });
    expect((await received).body).toBe('via rest');
  });

  test('joining a room over REST subscribes already-connected sockets', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const room = await createRoom(alice);
    const sb = await connect(bob);

    const joined = waitFor(sb, 'room:joined');
    await api().post(`/api/rooms/${room.id}/join`).set('Authorization', bob.auth);
    expect((await joined).room.id).toBe(room.id);

    const received = waitFor(sb, 'message:new');
    await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: 'welcome' });
    expect((await received).body).toBe('welcome');
  });

  test('room:join over the socket works and errors come back in the ack', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const room = await createRoom(alice);
    const sb = await connect(bob);

    const denied = await emitAck(sb, 'message:send', { roomId: room.id, body: 'let me in' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    expect((await emitAck(sb, 'room:join', { roomId: room.id })).ok).toBe(true);
    expect((await emitAck(sb, 'message:send', { roomId: room.id, body: 'hi' })).ok).toBe(true);
    expect((await emitAck(sb, 'room:join', { roomId: 9999 })).error.code).toBe('not_found');
  });

  test('direct messages reach the other user', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const [sa, sb] = await Promise.all([connect(alice), connect(bob)]);

    const dmOpened = waitFor(sb, 'room:joined');
    const { body } = await api().post(`/api/dm/${bob.id}`).set('Authorization', alice.auth);
    expect((await dmOpened).room.kind).toBe('direct');

    const received = waitFor(sb, 'message:new');
    await emitAck(sa, 'message:send', { roomId: body.room.id, body: 'psst' });
    expect(await received).toMatchObject({ roomId: body.room.id, body: 'psst' });
  });

  test('typing indicators go to other members but not the sender', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const room = await createRoom(alice, bob);
    const [sa, sb] = await Promise.all([connect(alice), connect(bob)]);

    const bobSees = waitFor(sb, 'typing');
    const aliceSilent = expectSilence(sa, 'typing');
    expect((await emitAck(sa, 'typing', { roomId: room.id })).ok).toBe(true);
    expect(await bobSees).toEqual({ roomId: room.id, userId: alice.id, username: alice.username });
    await aliceSilent;
  });

  test('socket messages share the per-user rate limit', async () => {
    const alice = await registerUser(server);
    const room = await createRoom(alice);
    const sa = await connect(alice);
    for (let i = 0; i < 3; i++) expect((await emitAck(sa, 'message:send', { roomId: room.id, body: `${i}` })).ok).toBe(true);
    const blocked = await emitAck(sa, 'message:send', { roomId: room.id, body: 'spam' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe('rate_limited');
    expect(blocked.error.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('presence', () => {
  test('users go online on first connection and offline after their last one closes', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const sb = await connect(bob);

    const online = waitFor(sb, 'presence:update', (p) => p.userId === alice.id && p.online);
    const tab1 = await connect(alice);
    await online;
    const tab2 = await connect(alice);

    let res = await api().get('/api/presence').set('Authorization', bob.auth);
    expect(res.body.userIds).toEqual([alice.id, bob.id].sort((a, b) => a - b));

    // Closing one of two tabs keeps Alice online.
    const quiet = expectSilence(sb, 'presence:update', 400);
    tab1.close();
    await quiet;
    expect((await api().get(`/api/presence/${alice.id}`).set('Authorization', bob.auth)).body.online).toBe(true);

    const offline = waitFor(sb, 'presence:update', (p) => p.userId === alice.id && !p.online);
    tab2.close();
    await offline;
    res = await api().get('/api/presence').set('Authorization', bob.auth);
    expect(res.body.userIds).toEqual([bob.id]);
  });

  test('presence:list over the socket', async () => {
    const alice = await registerUser(server);
    const sa = await connect(alice);
    const ack = await emitAck(sa, 'presence:list');
    expect(ack).toEqual({ ok: true, userIds: [alice.id] });
  });
});
