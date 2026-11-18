'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startServer, resetState, registerUser } = require('./helpers');

let server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());
beforeEach(resetState);

describe('auth', () => {
  test('register returns a user and a working token', async () => {
    const res = await request(server.app).post('/api/auth/register').send({ username: 'alice', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ id: expect.any(Number), username: 'alice' });

    const me = await request(server.app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('alice');
  });

  test('duplicate username is a 409', async () => {
    await registerUser(server, 'alice');
    const res = await request(server.app).post('/api/auth/register').send({ username: 'alice', password: 'password123' });
    expect(res.status).toBe(409);
  });

  test.each([
    [{ username: 'a', password: 'password123' }],
    [{ username: 'bad name!', password: 'password123' }],
    [{ username: 'alice', password: 'short' }],
    [{}],
  ])('rejects invalid credentials %j', async (body) => {
    const res = await request(server.app).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
  });

  test('login succeeds with the right password and fails otherwise', async () => {
    await registerUser(server, 'alice');
    const ok = await request(server.app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));

    const wrong = await request(server.app).post('/api/auth/login').send({ username: 'alice', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    const unknown = await request(server.app).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
    expect(unknown.status).toBe(401);
  });

  test('protected routes need a valid bearer token', async () => {
    expect((await request(server.app).get('/api/auth/me')).status).toBe(401);
    expect((await request(server.app).get('/api/auth/me').set('Authorization', 'Bearer junk')).status).toBe(401);

    const forged = jwt.sign({ sub: '1', sid: '00000000-0000-0000-0000-000000000000' }, 'wrong-secret');
    expect((await request(server.app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  test('logout revokes the session server-side', async () => {
    const alice = await registerUser(server, 'alice');
    const out = await request(server.app).post('/api/auth/logout').set('Authorization', alice.auth);
    expect(out.status).toBe(204);
    // Token is still a validly signed JWT, but its session row is revoked.
    const me = await request(server.app).get('/api/auth/me').set('Authorization', alice.auth);
    expect(me.status).toBe(401);
  });

  test('sessions are independent: logging out one device keeps the other', async () => {
    const alice = await registerUser(server, 'alice');
    const second = await request(server.app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    await request(server.app).post('/api/auth/logout').set('Authorization', alice.auth);
    const me = await request(server.app).get('/api/auth/me').set('Authorization', `Bearer ${second.body.token}`);
    expect(me.status).toBe(200);
  });

  test('health check reports the instance', async () => {
    const res = await request(server.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
