'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { badRequest, conflict, unauthorized } = require('../lib/errors');

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

// Used when a login names an unknown user, so the response time doesn't reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function toPublicUser(row) {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

function createAuthService({ db, config }) {
  function validateCredentials(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw badRequest('username must be 3-32 characters of letters, digits or underscore');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw badRequest('password must be 8-128 characters');
    }
  }

  async function issueToken(user, userAgent) {
    const { rows } = await db.query(
      `INSERT INTO sessions (user_id, expires_at, user_agent)
       VALUES ($1, now() + make_interval(secs => $2), $3)
       RETURNING id`,
      [user.id, config.jwtTtlSeconds, userAgent || null],
    );
    const sessionId = rows[0].id;
    const token = jwt.sign({ sub: String(user.id), sid: sessionId, username: user.username }, config.jwtSecret, {
      expiresIn: config.jwtTtlSeconds,
    });
    return { token, sessionId };
  }

  async function register(username, password, userAgent) {
    validateCredentials(username, password);
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    let user;
    try {
      const { rows } = await db.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
        [username, hash],
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') throw conflict('username is already taken');
      throw err;
    }
    const { token } = await issueToken(user, userAgent);
    return { user: toPublicUser(user), token };
  }

  async function login(username, password, userAgent) {
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw badRequest('username and password are required');
    }
    const { rows } = await db.query('SELECT id, username, password_hash, created_at FROM users WHERE username = $1', [
      username,
    ]);
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid username or password');
    const { token } = await issueToken(user, userAgent);
    return { user: toPublicUser(user), token };
  }

  /** Verifies the JWT signature *and* that its session row is still live (not revoked or expired). */
  async function authenticate(token) {
    let claims;
    try {
      claims = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const { rows } = await db.query(
      `SELECT u.id, u.username
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [claims.sid],
    );
    if (!rows[0]) throw unauthorized('Session has been revoked or has expired');
    return { id: rows[0].id, username: rows[0].username, sessionId: claims.sid };
  }

  async function logout(sessionId) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
  }

  return { register, login, authenticate, logout };
}

module.exports = { createAuthService };
