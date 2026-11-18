'use strict';

const { badRequest } = require('./errors');

/**
 * Opaque pagination cursor. It wraps the id of the last message the client has seen;
 * the next page is "messages in this room with id < cursor.id", which stays stable
 * while new messages keep arriving (unlike OFFSET-based paging).
 */
function encodeCursor(id) {
  return Buffer.from(JSON.stringify({ id })).toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Number.isSafeInteger(parsed.id) && parsed.id > 0) return parsed.id;
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

function parseLimit(raw, { fallback = 50, max = 100 } = {}) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw badRequest('limit must be a positive integer');
  return Math.min(value, max);
}

module.exports = { encodeCursor, decodeCursor, parseLimit };
