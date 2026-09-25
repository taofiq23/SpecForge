'use strict';

const { createClient } = require('redis');
const config = require('../config');

/**
 * Redis client (spec section D: "Cache: Redis 6-7").
 *
 * Section D's caching strategy is explicit:
 *   - "Cache game state in Redis"
 *   - "Use PostgreSQL for data persistence"
 * So Redis is a cache-aside layer in front of PostgreSQL, never the source of
 * truth.
 */
function createRedisClient(logger) {
  const client = createClient({
    url: config.redis.url,
    socket: {
      connectTimeout: config.redis.connectTimeoutMs,
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  });

  client.on('error', (err) => {
    logger && logger.warn({ err: err.message }, 'redis client error');
  });

  // Connect eagerly but never let a Redis outage crash a request path.
  client.connect().catch((err) => {
    logger && logger.warn({ err: err.message }, 'redis initial connect failed; cache disabled');
  });

  return client;
}

/**
 * Cache-aside helper. If Redis is unavailable the factory always falls through
 * to the loader so PostgreSQL remains authoritative (ASR-1 data durability).
 */
function createCacheAside(client, logger, { prefix = 'spacefractions', ttlSeconds = 300 } = {}) {
  function key(k) {
    return `${prefix}:${k}`;
  }

  return {
    async get(k) {
      if (!client || !client.isReady) return null;
      try {
        const raw = await client.get(key(k));
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        logger && logger.warn({ err: err.message, key: k }, 'cache read miss (redis unavailable)');
        return null;
      }
    },

    async set(k, value, ttl = ttlSeconds) {
      if (!client || !client.isReady) return false;
      try {
        await client.set(key(k), JSON.stringify(value), { EX: ttl });
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, key: k }, 'cache write failed');
        return false;
      }
    },

    async del(k) {
      if (!client || !client.isReady) return false;
      try {
        await client.del(key(k));
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, key: k }, 'cache delete failed');
        return false;
      }
    },

    /**
     * read-through: return cached value if present, otherwise call loader and
     * populate the cache.
     */
    async remember(k, loader, ttl = ttlSeconds) {
      const cached = await this.get(k);
      if (cached !== null && cached !== undefined) return cached;
      const fresh = await loader();
      if (fresh !== null && fresh !== undefined) await this.set(k, fresh, ttl);
      return fresh;
    },
  };
}

module.exports = { createRedisClient, createCacheAside };
