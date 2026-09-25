'use strict';

const config = require('./config');
const { createLogger } = require('./logger');
const { createPool, withTransaction, ping } = require('./db/postgres');
const { createRedisClient, createCacheAside } = require('./db/redis');
const { createMessaging } = require('./messaging/rabbitmq');
const { createSearchClient } = require('./search/elasticsearch');
const { createMetrics } = require('./observability/metrics');
const { createApp } = require('./http/app');
const { request, createServiceRegistry } = require('./http/client');
const oauth2 = require('./auth/oauth2');
const domain = require('./domain');

module.exports = {
  config,
  createLogger,
  postgres: { createPool, withTransaction, ping },
  redis: { createRedisClient, createCacheAside },
  messaging: { createMessaging },
  search: { createSearchClient },
  observability: { createMetrics },
  http: { createApp, request, createServiceRegistry },
  oauth2,
  domain,
};
