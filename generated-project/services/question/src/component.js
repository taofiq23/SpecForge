'use strict';

/**
 * QuestionComponent - the component named in the ComponentDiagram (spec.json
 * view 9) and in the traceability matrix for ASR-1 (data durability).
 *
 *   artifact QuestionComponent
 *   GameComponent -- QuestionComponent
 *
 * Responsibilities (spec section C/D): "question management and data
 * persistence. [QuestionComponent owns question data.]"
 *
 * Stack (spec section D, recommended defaults): Node.js 18, Express.js 4,
 * PostgreSQL 14, Redis 6, RabbitMQ 3, Elasticsearch 7, OAuth2, Prometheus 2,
 * Docker 20.
 *
 * ASR-1 mitigation, straight from section D/E:
 *   - "Use PostgreSQL for data persistence"
 *   - "Implement data replication for high availability"
 *   - "Use PostgreSQL replication for high availability"
 *   - "Implement regular backups and data replication"
 */
const shared = require('@spacefractions/shared');
const { config } = shared;

const { QuestionService } = require('./service/questionService');
const { QuestionRepository } = require('./repository/questionRepository');
const { createQuestionRoutes } = require('./routes/questionRoutes');

const ELASTIC_INDEX = process.env.QUESTION_INDEX || 'spacefractions-questions';

class QuestionComponent {
  constructor(options = {}) {
    this.name = 'QuestionComponent';
    this.config = config;
    this.logger = options.logger || shared.createLogger(this.name);
    this.metrics = options.metrics || shared.observability.createMetrics(this.name);

    this.pool = options.pool || shared.postgres.createPool(this.logger, {
      schema: config.schemas.question,
    });

    this.redis = options.redis || shared.redis.createRedisClient(this.logger);
    this.cache = options.cache || shared.redis.createCacheAside(this.redis, this.logger, {
      prefix: 'spacefractions:question',
      ttlSeconds: config.redis.questionCacheTtlSeconds,
    });

    this.messaging = options.messaging || shared.messaging.createMessaging(this.logger, {
      component: this.name,
    });

    this.search = options.search || shared.search.createSearchClient(this.logger, ELASTIC_INDEX);

    this.repository = options.repository || new QuestionRepository({
      pool: this.pool,
      cache: this.cache,
      search: this.search,
      logger: this.logger,
      schema: config.schemas.question,
      metrics: this.metrics,
    });

    this.service = options.service || new QuestionService({
      repository: this.repository,
      messaging: this.messaging,
      metrics: this.metrics,
      logger: this.logger,
      config,
    });

    this.app = this.buildApp();
  }

  buildApp() {
    return shared.http.createApp({
      componentName: this.name,
      logger: this.logger,
      metrics: this.metrics,
      readyChecks: [
        // ASR-1: PostgreSQL is the durable store, so it gates readiness.
        { name: 'postgres', check: () => shared.postgres.ping(this.pool), required: true },
        { name: 'redis', check: () => this.redis.isReady, required: false },
        { name: 'rabbitmq', check: () => this.messaging.isConnected(), required: false },
        { name: 'elasticsearch', check: () => this.search.ping(), required: false },
      ],
      // Registered through the factory's mount hook so these routes land before
      // its terminal 404 handler.
      mountRoutes: (app) => {
        app.use(createQuestionRoutes({ service: this.service, logger: this.logger }));

        // Section G: "Create a runbook for common issues and errors." The seed /
        // recovery endpoint is the operational hook for that runbook (ASR-1).
        app.post('/internal/seed', async (req, res, next) => {
          try {
            res.json(await this.service.seed({ force: Boolean(req.body && req.body.force) }));
          } catch (err) {
            next(err);
          }
        });
      },
    });
  }

  /** Bootstrap: create schema objects and index, then seed if empty. */
  async initialise() {
    try {
      await this.search.ensureIndex();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'elasticsearch index bootstrap skipped');
    }
    try {
      const result = await this.service.seed();
      this.logger.info(result, 'question seed bootstrap complete');
    } catch (err) {
      this.logger.warn({ err: err.message }, 'question seed bootstrap skipped (database not ready?)');
    }
  }

  async start() {
    const { port, host } = config.question;
    await this.initialise();
    this.server = this.app.listen(port, host, () => {
      this.logger.info({ port, host, component: this.name }, `${this.name} listening`);
    });
    return this.server;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    await this.messaging.close();
    try {
      await this.redis.quit();
    } catch (_) {
      /* already closed */
    }
    await this.pool.end();
  }
}

module.exports = { QuestionComponent };
