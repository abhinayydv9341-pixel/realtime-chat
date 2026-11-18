'use strict';

const request = require('supertest');
const { startServer, resetState, registerUser } = require('./helpers');

let server;
beforeAll(async () => {
  // Generous limit so pagination tests can seed history; rate limiting has its own server below.
  server = await startServer({ rateLimit: { messages: 1000, windowMs: 1000 } });
});
afterAll(() => server.close());
beforeEach(resetState);

const api = () => request(server.app);

async function roomWith(owner, ...members) {
  const { body } = await api().post('/api/rooms').set('Authorization', owner.auth).send({ name: 'general' });
  for (const m of members) await api().post(`/api/rooms/${body.room.id}/join`).set('Authorization', m.auth);
  return body.room;
}

describe('messages', () => {
  test('members can post and read history', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const room = await roomWith(alice, bob);

    const sent = await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: 'hi' });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ roomId: room.id, senderId: alice.id, senderUsername: alice.username });

    const history = await api().get(`/api/rooms/${room.id}/messages`).set('Authorization', bob.auth);
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m) => m.body)).toEqual(['hi']);
    expect(history.body.nextCursor).toBeNull();
  });

  test('non-members can neither read nor write', async () => {
    const alice = await registerUser(server);
    const eve = await registerUser(server);
    const room = await roomWith(alice);
    expect((await api().get(`/api/rooms/${room.id}/messages`).set('Authorization', eve.auth)).status).toBe(403);
    expect(
      (await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', eve.auth).send({ body: 'x' })).status,
    ).toBe(403);
    expect((await api().get('/api/rooms/9999/messages').set('Authorization', eve.auth)).status).toBe(404);
  });

  test('message body is validated', async () => {
    const alice = await registerUser(server);
    const room = await roomWith(alice);
    const post = (body) => api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send(body);
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ body: 'x'.repeat(2001) })).status).toBe(400);
  });

  test('cursor pagination walks the whole history newest-first without gaps or duplicates', async () => {
    const alice = await registerUser(server);
    const room = await roomWith(alice);
    for (let i = 1; i <= 23; i++) {
      await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: `m${i}` });
    }

    const seen = [];
    let cursor = '';
    let pages = 0;
    do {
      const res = await api()
        .get(`/api/rooms/${room.id}/messages`)
        .query({ limit: 10, cursor })
        .set('Authorization', alice.auth);
      expect(res.status).toBe(200);
      seen.push(...res.body.messages.map((m) => m.body));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => `m${23 - i}`));
  });

  test('new messages arriving mid-pagination do not shift older pages', async () => {
    const alice = await registerUser(server);
    const room = await roomWith(alice);
    for (let i = 1; i <= 4; i++) {
      await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: `m${i}` });
    }
    const page1 = await api().get(`/api/rooms/${room.id}/messages?limit=2`).set('Authorization', alice.auth);
    await api().post(`/api/rooms/${room.id}/messages`).set('Authorization', alice.auth).send({ body: 'late' });
    const page2 = await api()
      .get(`/api/rooms/${room.id}/messages`)
      .query({ limit: 2, cursor: page1.body.nextCursor })
      .set('Authorization', alice.auth);
    expect(page1.body.messages.map((m) => m.body)).toEqual(['m4', 'm3']);
    expect(page2.body.messages.map((m) => m.body)).toEqual(['m2', 'm1']);
  });

  test('invalid cursor and limit are rejected', async () => {
    const alice = await registerUser(server);
    const room = await roomWith(alice);
    expect((await api().get(`/api/rooms/${room.id}/messages?cursor=nope`).set('Authorization', alice.auth)).status).toBe(
      400,
    );
    expect((await api().get(`/api/rooms/${room.id}/messages?limit=0`).set('Authorization', alice.auth)).status).toBe(400);
  });
});

describe('message rate limiting', () => {
  let limited;
  beforeAll(async () => {
    limited = await startServer({ rateLimit: { messages: 3, windowMs: 1500 } });
  });
  afterAll(() => limited.close());

  test('the 4th message inside the window is a 429 with Retry-After, and quota recovers', async () => {
    const alice = await registerUser(limited);
    const { body } = await request(limited.app).post('/api/rooms').set('Authorization', alice.auth).send({ name: 'r' });
    const post = () =>
      request(limited.app).post(`/api/rooms/${body.room.id}/messages`).set('Authorization', alice.auth).send({ body: 'x' });

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post()).status);
    expect(statuses).toEqual([201, 201, 201]);

    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');

    await new Promise((r) => setTimeout(r, 1600));
    expect((await post()).status).toBe(201);
  });

  test('limits are per user', async () => {
    const alice = await registerUser(limited);
    const bob = await registerUser(limited);
    const { body } = await request(limited.app).post('/api/rooms').set('Authorization', alice.auth).send({ name: 'r' });
    await request(limited.app).post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth);
    const post = (u) =>
      request(limited.app).post(`/api/rooms/${body.room.id}/messages`).set('Authorization', u.auth).send({ body: 'x' });

    for (let i = 0; i < 3; i++) await post(alice);
    expect((await post(alice)).status).toBe(429);
    expect((await post(bob)).status).toBe(201);
  });
});
