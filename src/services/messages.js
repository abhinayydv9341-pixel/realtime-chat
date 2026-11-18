'use strict';

const { badRequest, forbidden } = require('../lib/errors');
const { encodeCursor } = require('../lib/cursor');

const MAX_BODY = 2000;

function toMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderUsername: row.sender_username,
    body: row.body,
    createdAt: row.created_at,
  };
}

function createMessageService({ db, rooms }) {
  async function assertMember(roomId, userId) {
    await rooms.get(roomId); // 404 when the room doesn't exist
    if (!(await rooms.isMember(roomId, userId))) throw forbidden('You are not a member of this room');
  }

  async function send(roomId, senderId, body) {
    if (typeof body !== 'string' || !body.trim()) throw badRequest('body must be a non-empty string');
    if (body.length > MAX_BODY) throw badRequest(`body must be at most ${MAX_BODY} characters`);
    await assertMember(roomId, senderId);
    const { rows } = await db.query(
      `WITH inserted AS (
         INSERT INTO messages (room_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *
       )
       SELECT i.*, u.username AS sender_username FROM inserted i JOIN users u ON u.id = i.sender_id`,
      [roomId, senderId, body],
    );
    return toMessage(rows[0]);
  }

  /**
   * Newest-first page of history. Fetches limit + 1 rows to learn whether another page
   * exists without a separate COUNT query.
   */
  async function list(roomId, userId, { beforeId = null, limit = 50 } = {}) {
    await assertMember(roomId, userId);
    const { rows } = await db.query(
      `SELECT m.*, u.username AS sender_username
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.room_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
        ORDER BY m.id DESC
        LIMIT $3`,
      [roomId, beforeId, limit + 1],
    );
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(toMessage);
    return { messages, nextCursor: hasMore ? encodeCursor(messages[messages.length - 1].id) : null };
  }

  return { send, list };
}

module.exports = { createMessageService };
