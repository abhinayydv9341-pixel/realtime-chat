'use strict';

const { HttpError } = require('../lib/errors');

const roomChannel = (roomId) => `room:${roomId}`;
const userChannel = (userId) => `user:${userId}`;
const sessionChannel = (sessionId) => `session:${sessionId}`;

function errorPayload(err) {
  if (err instanceof HttpError) return { ok: false, error: { code: err.code, message: err.message, ...err.extra } };
  return { ok: false, error: { code: 'internal', message: 'Internal error' } };
}

/**
 * Wraps a socket event handler: awaits connection setup, converts thrown errors into an
 * `{ ok: false, error }` acknowledgement, and never lets a rejection go unhandled.
 */
function handler(socket, fn, log) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      await socket.data.ready;
      reply({ ok: true, ...(await fn(payload || {})) });
    } catch (err) {
      if (!(err instanceof HttpError)) log.error('socket handler failed', err);
      reply(errorPayload(err));
    }
  };
}

function toId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Socket.IO protocol
 *
 * client -> server (all accept an ack callback that receives { ok, ... } or { ok: false, error })
 *   message:send { roomId, body }  -> { message }
 *   room:join    { roomId }        -> { room }
 *   room:leave   { roomId }
 *   typing       { roomId }
 *   presence:list                  -> { userIds }
 *
 * server -> client
 *   session:ready   { user, roomIds }       once per connection, after rooms are joined
 *   message:new     message
 *   presence:update { userId, username, online }
 *   typing          { roomId, userId, username }
 *   room:joined     { room }                you were added to a room (e.g. a new DM)
 */
function attachSocketHandlers(io, { auth, rooms, messages, presence, limiter, log }) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = await auth.authenticate(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Handlers are registered synchronously; each awaits `ready` so events sent
    // immediately after connecting aren't processed before the socket has joined its rooms.
    socket.data.ready = (async () => {
      const roomIds = await rooms.listRoomIdsForUser(user.id);
      socket.join([userChannel(user.id), sessionChannel(user.sessionId), ...roomIds.map(roomChannel)]);
      const cameOnline = await presence.connect(user.id, socket.id);
      if (cameOnline) io.emit('presence:update', { userId: user.id, username: user.username, online: true });
      socket.emit('session:ready', { user: { id: user.id, username: user.username }, roomIds });
    })();
    socket.data.ready.catch((err) => {
      log.error('socket setup failed', err);
      socket.disconnect(true);
    });

    socket.on(
      'message:send',
      handler(
        socket,
        async ({ roomId, body }) => {
          const id = toId(roomId);
          if (!id) throw new HttpError(400, 'bad_request', 'roomId is required');
          const verdict = await limiter.consume(`messages:${user.id}`);
          if (!verdict.allowed) {
            throw new HttpError(429, 'rate_limited', 'Too many messages, slow down', {
              retryAfterMs: verdict.retryAfterMs,
            });
          }
          const message = await messages.send(id, user.id, body);
          io.to(roomChannel(id)).emit('message:new', message);
          return { message };
        },
        log,
      ),
    );

    socket.on(
      'room:join',
      handler(
        socket,
        async ({ roomId }) => {
          const room = await rooms.join(toId(roomId), user.id);
          // Join every tab/device of this user, on whichever instance they're connected to.
          io.in(userChannel(user.id)).socketsJoin(roomChannel(room.id));
          return { room };
        },
        log,
      ),
    );

    socket.on(
      'room:leave',
      handler(
        socket,
        async ({ roomId }) => {
          const room = await rooms.leave(toId(roomId), user.id);
          io.in(userChannel(user.id)).socketsLeave(roomChannel(room.id));
          return {};
        },
        log,
      ),
    );

    socket.on(
      'typing',
      handler(
        socket,
        async ({ roomId }) => {
          const id = toId(roomId);
          if (!id || !socket.rooms.has(roomChannel(id))) {
            throw new HttpError(403, 'forbidden', 'You are not a member of this room');
          }
          socket.to(roomChannel(id)).emit('typing', { roomId: id, userId: user.id, username: user.username });
          return {};
        },
        log,
      ),
    );

    socket.on(
      'presence:list',
      handler(socket, async () => ({ userIds: await presence.onlineUserIds() }), log),
    );

    socket.on('disconnect', async () => {
      try {
        await socket.data.ready.catch(() => {});
        const wentOffline = await presence.disconnect(user.id, socket.id);
        if (wentOffline) io.emit('presence:update', { userId: user.id, username: user.username, online: false });
      } catch (err) {
        log.error('presence disconnect failed', err);
      }
    });
  });
}

/** What HTTP routes use to push events to connected clients (on any instance). */
function createRealtimeFacade(getIo) {
  return {
    emitToRoom(roomId, event, payload) {
      getIo().to(roomChannel(roomId)).emit(event, payload);
    },
    addUserToRoom(userId, room) {
      const io = getIo();
      io.in(userChannel(userId)).socketsJoin(roomChannel(room.id));
      io.to(userChannel(userId)).emit('room:joined', { room });
    },
    removeUserFromRoom(userId, roomId) {
      getIo().in(userChannel(userId)).socketsLeave(roomChannel(roomId));
    },
    disconnectSession(sessionId) {
      getIo().in(sessionChannel(sessionId)).disconnectSockets(true);
    },
  };
}

module.exports = { attachSocketHandlers, createRealtimeFacade };
