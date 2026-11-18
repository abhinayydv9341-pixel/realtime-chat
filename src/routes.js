'use strict';

const express = require('express');
const { requireAuth, rateLimit, idParam } = require('./middleware');
const { decodeCursor, parseLimit } = require('./lib/cursor');

function createRouter({ auth, rooms, messages, presence, limiter, realtime }) {
  const router = express.Router();
  const authed = requireAuth(auth);
  const messageRateLimit = rateLimit(limiter, (req) => `messages:${req.user.id}`);

  // ---- auth -------------------------------------------------------------
  router.post('/auth/register', async (req, res) => {
    const { username, password } = req.body || {};
    res.status(201).json(await auth.register(username, password, req.get('user-agent')));
  });

  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    res.json(await auth.login(username, password, req.get('user-agent')));
  });

  router.post('/auth/logout', authed, async (req, res) => {
    await auth.logout(req.user.sessionId);
    realtime.disconnectSession(req.user.sessionId);
    res.status(204).end();
  });

  router.get('/auth/me', authed, (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username } });
  });

  // ---- rooms ------------------------------------------------------------
  router.get('/rooms', authed, async (req, res) => {
    res.json({ rooms: await rooms.listForUser(req.user.id) });
  });

  router.get('/rooms/public', authed, async (req, res) => {
    res.json({ rooms: await rooms.listPublic() });
  });

  router.post('/rooms', authed, async (req, res) => {
    const room = await rooms.create((req.body || {}).name, req.user.id);
    realtime.addUserToRoom(req.user.id, room);
    res.status(201).json({ room });
  });

  router.post('/rooms/:roomId/join', authed, async (req, res) => {
    const room = await rooms.join(idParam(req, 'roomId'), req.user.id);
    realtime.addUserToRoom(req.user.id, room);
    res.json({ room });
  });

  router.post('/rooms/:roomId/leave', authed, async (req, res) => {
    const room = await rooms.leave(idParam(req, 'roomId'), req.user.id);
    realtime.removeUserFromRoom(req.user.id, room.id);
    res.status(204).end();
  });

  // ---- messages ---------------------------------------------------------
  router.get('/rooms/:roomId/messages', authed, async (req, res) => {
    const page = await messages.list(idParam(req, 'roomId'), req.user.id, {
      beforeId: decodeCursor(req.query.cursor),
      limit: parseLimit(req.query.limit),
    });
    res.json(page);
  });

  router.post('/rooms/:roomId/messages', authed, messageRateLimit, async (req, res) => {
    const roomId = idParam(req, 'roomId');
    const message = await messages.send(roomId, req.user.id, (req.body || {}).body);
    realtime.emitToRoom(roomId, 'message:new', message);
    res.status(201).json({ message });
  });

  // ---- direct messages --------------------------------------------------
  router.post('/dm/:userId', authed, async (req, res) => {
    const { room, memberIds } = await rooms.getOrCreateDirect(req.user.id, idParam(req, 'userId'));
    for (const id of memberIds) realtime.addUserToRoom(id, room);
    res.json({ room });
  });

  // ---- presence ---------------------------------------------------------
  router.get('/presence', authed, async (req, res) => {
    res.json({ userIds: await presence.onlineUserIds() });
  });

  router.get('/presence/:userId', authed, async (req, res) => {
    const userId = idParam(req, 'userId');
    res.json({ userId, online: await presence.isOnline(userId) });
  });

  return router;
}

module.exports = { createRouter };
