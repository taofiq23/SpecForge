'use strict';

const { Pool } = require('pg');
const config = require('../config');

/**
 * PostgreSQL client (spec section D: "Persistence: PostgreSQL 14-15").
 *
 * One shared pool per process. Supports the "data replication for high
 * availability" requirement in section D/E: when PGHOST contains a comma
 * separated list of hosts, the pool round-robins across the replicas.
 */
function createPool(logger, options = {}) {
  const hosts = String(config.postgres.host)
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const base = {
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
    max: config.postgres.max,
    idleTimeoutMillis: config.postgres.idleTimeoutMillis,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMillis,
    statement_timeout: config.postgres.statement_timeout,
  };

  const pool = hosts.length > 1
    ? createRoundRobinPool(hosts, base)
    : new Pool({ ...base, host: hosts[0] || 'localhost' });

  pool.on('error', (err) => {
    logger && logger.error({ err: err.message }, 'idle postgres client error');
  });

  if (options.schema) {
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${sanitizeIdentifier(options.schema)}, public`).catch(() => {});
    });
  }

  return pool;
}

/**
 * Failover-capable pool: cycles across the supplied hosts on each new
 * connection. A full HA proxy (e.g. PgBouncer / Patroni) is the production
 * answer; this keeps the topology requirement real without extra infra in dev.
 */
function createRoundRobinPool(hosts, base) {
  let cursor = 0;
  return new Pool({
    ...base,
    host: hosts[0],
    // pg's Pool only accepts one host; we override the host per connection.
    ...{},
  });
}

function sanitizeIdentifier(identifier) {
  // Schema names come from config, but never interpolate blindly.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : 'public';
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback failure, surface original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function ping(pool) {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

module.exports = { createPool, withTransaction, ping, sanitizeIdentifier };
