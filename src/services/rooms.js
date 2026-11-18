'use strict';

const { withTransaction } = require('../db');
const { badRequest, notFound } = require('../lib/errors');

function toRoom(row) {
  const room = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (row.member_count !== undefined) room.memberCount = row.member_count;
  return room;
}

const WITH_MEMBER_COUNT = `SELECT r.*, (SELECT count(*)::int FROM room_members x WHERE x.room_id = r.id) AS member_count`;

function createRoomService({ db }) {
  async function create(name, userId) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
      throw badRequest('name must be 1-64 characters');
    }
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`INSERT INTO rooms (name, kind, created_by) VALUES ($1, 'group', $2) RETURNING *`, [
        name.trim(),
        userId,
      ]);
      await tx.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [rows[0].id, userId]);
      return toRoom({ ...rows[0], member_count: 1 });
    });
  }

  async function listForUser(userId) {
    const { rows } = await db.query(
      `${WITH_MEMBER_COUNT}
         FROM rooms r JOIN room_members m ON m.room_id = r.id
        WHERE m.user_id = $1
        ORDER BY r.id`,
      [userId],
    );
    return rows.map(toRoom);
  }

  async function listRoomIdsForUser(userId) {
    const { rows } = await db.query('SELECT room_id FROM room_members WHERE user_id = $1', [userId]);
    return rows.map((r) => r.room_id);
  }

  async function listPublic() {
    const { rows } = await db.query(`${WITH_MEMBER_COUNT} FROM rooms r WHERE r.kind = 'group' ORDER BY r.id`);
    return rows.map(toRoom);
  }

  async function get(roomId) {
    const { rows } = await db.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (!rows[0]) throw notFound('Room not found');
    return toRoom(rows[0]);
  }

  async function join(roomId, userId) {
    const room = await get(roomId);
    // Direct conversations are private; pretend they don't exist to outsiders.
    if (room.kind !== 'group') throw notFound('Room not found');
    await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, userId]);
    return room;
  }

  async function leave(roomId, userId) {
    const room = await get(roomId);
    if (room.kind !== 'group') throw badRequest('Cannot leave a direct conversation');
    await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    return room;
  }

  async function isMember(roomId, userId) {
    const { rowCount } = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      userId,
    ]);
    return rowCount > 0;
  }

  /** Direct messages are a two-member room keyed by the sorted user-id pair, so it is created once. */
  async function getOrCreateDirect(userId, otherUserId) {
    if (userId === otherUserId) throw badRequest('Cannot open a direct conversation with yourself');
    const { rows: users } = await db.query('SELECT id, username FROM users WHERE id = ANY($1::bigint[])', [
      [userId, otherUserId],
    ]);
    const me = users.find((u) => u.id === userId);
    const other = users.find((u) => u.id === otherUserId);
    if (!other) throw notFound('User not found');

    const [a, b] = [userId, otherUserId].sort((x, y) => x - y);
    const key = `${a}:${b}`;
    return withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO rooms (name, kind, direct_key, created_by) VALUES ($1, 'direct', $2, $3)
         ON CONFLICT (direct_key) DO NOTHING`,
        [`${me.username} & ${other.username}`, key, userId],
      );
      const { rows } = await tx.query('SELECT * FROM rooms WHERE direct_key = $1', [key]);
      await tx.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [
        rows[0].id,
        a,
        b,
      ]);
      return { room: toRoom(rows[0]), memberIds: [a, b] };
    });
  }

  return { create, listForUser, listRoomIdsForUser, listPublic, get, join, leave, isMember, getOrCreateDirect };
}

module.exports = { createRoomService };
