'use strict';

const request = require('supertest');
const { startServer, resetState, registerUser } = require('./helpers');

let server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());
beforeEach(resetState);

const api = () => request(server.app);

describe('rooms', () => {
  test('creator is a member of a new room', async () => {
    const alice = await registerUser(server);
    const created = await api().post('/api/rooms').set('Authorization', alice.auth).send({ name: '  general ' });
    expect(created.status).toBe(201);
    expect(created.body.room).toMatchObject({ name: 'general', kind: 'group', memberCount: 1 });

    const mine = await api().get('/api/rooms').set('Authorization', alice.auth);
    expect(mine.body.rooms.map((r) => r.name)).toEqual(['general']);
  });

  test('room name is validated', async () => {
    const alice = await registerUser(server);
    expect((await api().post('/api/rooms').set('Authorization', alice.auth).send({ name: '' })).status).toBe(400);
    expect((await api().post('/api/rooms').set('Authorization', alice.auth).send({ name: 'x'.repeat(65) })).status).toBe(
      400,
    );
  });

  test('users can discover, join and leave group rooms', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const { body } = await api().post('/api/rooms').set('Authorization', alice.auth).send({ name: 'general' });

    const pub = await api().get('/api/rooms/public').set('Authorization', bob.auth);
    expect(pub.body.rooms).toHaveLength(1);

    expect((await api().post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth)).status).toBe(200);
    // joining twice is idempotent
    expect((await api().post(`/api/rooms/${body.room.id}/join`).set('Authorization', bob.auth)).status).toBe(200);
    const mine = await api().get('/api/rooms').set('Authorization', bob.auth);
    expect(mine.body.rooms[0].memberCount).toBe(2);

    expect((await api().post(`/api/rooms/${body.room.id}/leave`).set('Authorization', bob.auth)).status).toBe(204);
    expect((await api().get('/api/rooms').set('Authorization', bob.auth)).body.rooms).toEqual([]);
  });

  test('joining a missing room is a 404 and a bad id is a 400', async () => {
    const alice = await registerUser(server);
    expect((await api().post('/api/rooms/9999/join').set('Authorization', alice.auth)).status).toBe(404);
    expect((await api().post('/api/rooms/abc/join').set('Authorization', alice.auth)).status).toBe(400);
  });

  test('direct conversations are created once per pair', async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const first = await api().post(`/api/dm/${bob.id}`).set('Authorization', alice.auth);
    const second = await api().post(`/api/dm/${alice.id}`).set('Authorization', bob.auth);
    expect(first.status).toBe(200);
    expect(first.body.room.kind).toBe('direct');
    expect(second.body.room.id).toBe(first.body.room.id);

    // DMs are not listed publicly and can't be joined by a third user.
    const carol = await registerUser(server);
    expect((await api().get('/api/rooms/public').set('Authorization', carol.auth)).body.rooms).toEqual([]);
    expect((await api().post(`/api/rooms/${first.body.room.id}/join`).set('Authorization', carol.auth)).status).toBe(404);
  });

  test('direct conversation edge cases', async () => {
    const alice = await registerUser(server);
    expect((await api().post(`/api/dm/${alice.id}`).set('Authorization', alice.auth)).status).toBe(400);
    expect((await api().post('/api/dm/9999').set('Authorization', alice.auth)).status).toBe(404);
  });
});
