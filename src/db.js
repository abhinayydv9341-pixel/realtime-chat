'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// BIGINT/BIGSERIAL come back as strings by default; our ids stay well inside 2^53.
types.setTypeParser(20, (value) => parseInt(value, 10));

const MIGRATION_LOCK_ID = 727_001;

function createPool(connectionString) {
  return new Pool({ connectionString, max: 10 });
}

/** Applies db/schema.sql. An advisory lock keeps concurrently booting instances from racing. */
async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, withTransaction };
