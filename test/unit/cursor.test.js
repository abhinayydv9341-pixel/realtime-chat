'use strict';

const { encodeCursor, decodeCursor, parseLimit } = require('../../src/lib/cursor');

describe('cursor', () => {
  test('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  test('empty cursor means "start from newest"', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  test.each(['garbage', Buffer.from('{"id":-1}').toString('base64url'), Buffer.from('{"id":"7"}').toString('base64url')])(
    'rejects malformed cursor %s',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow('Invalid cursor');
    },
  );

  test('limit defaults, caps and validates', () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit('1000')).toBe(100);
    expect(() => parseLimit('0')).toThrow();
    expect(() => parseLimit('abc')).toThrow();
  });
});
