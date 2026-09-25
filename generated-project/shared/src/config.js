'use strict';

/**
 * Centralised runtime configuration for every Space Fractions component.
 *
 * The spec (section D) names a technology stack per component but does not give
 * connection strings, so every value here is read from the environment with a
 * development default that matches docker-compose.yml.
 */

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const config = {
  env: process.env.NODE_ENV || 'development',

  // --- HTTP ports. Values chosen so all three can run side by side locally. ---
  game: {
    port: int('GAME_PORT', 8081),
    host: process.env.GAME_HOST || '0.0.0.0',
    name: 'GameComponent',
  },
  question: {
    port: int('QUESTION_PORT', 8082),
    host: process.env.QUESTION_HOST || '0.0.0.0',
    name: 'QuestionComponent',
  },
  user: {
    port: int('USER_PORT', 8083),
    host: process.env.USER_HOST || '0.0.0.0',
    name: 'UserComponent',
  },

  // --- Persistence: PostgreSQL 14 (spec section D, recommended default stack) ---
  postgres: {
    host: process.env.PGHOST || 'localhost',
    port: int('PGPORT', 5432),
    user: process.env.PGUSER || 'spacefractions',
    password: process.env.PGPASSWORD || 'spacefractions',
    database: process.env.PGDATABASE || 'spacefractions',
    // Logical database names are never given by the spec; we run one PostgreSQL
    // instance and let each component own its own schema (data ownership).
    max: int('PG_POOL_MAX', 10),
    idleTimeoutMillis: int('PG_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMillis: int('PG_CONNECT_TIMEOUT_MS', 3000),
    statement_timeout: int('PG_STATEMENT_TIMEOUT_MS', 5000),
  },

  schemas: {
    game: process.env.GAME_SCHEMA || 'game',
    question: process.env.QUESTION_SCHEMA || 'question',
    user: process.env.USER_SCHEMA || 'user',
  },

  // --- Cache: Redis 6 (spec section D) ---
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    // Caching & consistency strategy from section D: "Cache game state in Redis".
    gameStateTtlSeconds: int('GAME_STATE_TTL_SECONDS', 3600),
    questionCacheTtlSeconds: int('QUESTION_CACHE_TTL_SECONDS', 900),
    connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', 3000),
  },

  // --- Messaging: RabbitMQ 3 (spec section D). Section D never says what flows
  //     through it; see README "Underspecified areas" for the events we chose. ---
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://spacefractions:spacefractions@localhost:5672',
    exchange: process.env.RABBITMQ_EXCHANGE || 'spacefractions.events',
    events: {
      gameStarted: 'game.started',
      gameCompleted: 'game.completed',
      answerSubmitted: 'question.answered',
      questionUpdated: 'question.updated',
      userAuthenticated: 'user.authenticated',
    },
    connectTimeoutMs: int('RABBITMQ_CONNECT_TIMEOUT_MS', 3000),
  },

  // --- Search: Elasticsearch 7 (spec section D) ---
  elasticsearch: {
    node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    index: process.env.ELASTICSEARCH_INDEX || 'spacefractions-questions',
    requestTimeout: int('ELASTICSEARCH_TIMEOUT_MS', 3000),
  },

  // --- Authn/authz: OAuth2 (spec section D + F) ---
  oauth2: {
    issuer: process.env.OAUTH2_ISSUER || 'http://localhost:8083',
    audience: process.env.OAUTH2_AUDIENCE || 'spacefractions-api',
    // HS256 shared secret used when no JWKS endpoint is configured. Production
    // deployments are expected to set OAUTH2_JWKS_URI instead (see README).
    secret: process.env.OAUTH2_SECRET || 'spacefractions-dev-secret-change-me',
    jwksUri: process.env.OAUTH2_JWKS_URI || '',
    publicPaths: [
      '/health', '/ready', '/metrics', '/openapi.json', '/api/v1/play',
      '/api/v1/questions', '/oauth/token',
    ],
  },

  // --- Frontend (DeploymentDiagram: UserClient / AdminClient) ---
  // The spec's executive summary describes a UI but never names a frontend
  // technology. The chosen default is plain HTML/CSS/JS served as static files
  // by GameComponent - no build step, no framework. Set WEB_UI_ENABLED=false to
  // serve the API only (e.g. if a separate client deployment is used).
  webUiEnabled: bool('WEB_UI_ENABLED', true),
  webUiRoot: process.env.WEB_UI_ROOT || '',

  // --- Observability: Prometheus 2 (spec section D) ---
  prometheus: {
    // /metrics is served by prom-client's default registry on every component.
    enabled: bool('PROMETHEUS_ENABLED', true),
    defaultLabels: { application: 'spacefractions' },
  },

  // SLO from section G: 99.99% uptime.
  slo: {
    uptimeTarget: 0.9999,
    latencyBudgetMs: int('LATENCY_BUDGET_MS', 250),
  },
};

module.exports = config;
