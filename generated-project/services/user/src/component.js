'use strict';

/**
 * UserComponent - the component named in the ComponentDiagram (spec.json view 9)
 * and in the spec's component list (section C/D).
 *
 *   artifact UserComponent
 *   GameComponent -- UserComponent
 *
 * Responsibilities (spec section C): "user authentication and authorization".
 * Section F: OAuth2, secure password storage and transmission, secrets manager
 * (Vault), regular rotation, TLS, Istio service mesh, threat model with the top
 * 5 threats mitigated.
 *
 * Stack (spec section D, recommended defaults): Node.js 18, Express.js 4,
 * PostgreSQL 14, Redis 6, RabbitMQ 3, OAuth2, Prometheus 2, Docker 20.
 */
const shared = require('@spacefractions/shared');
const { config } = shared;

const { UserService } = require('./service/userService');
const { UserRepository } = require('./repository/userRepository');
const { createUserRoutes } = require('./routes/userRoutes');

class UserComponent {
  constructor(options = {}) {
    this.name = 'UserComponent';
    this.config = config;
    this.logger = options.logger || shared.createLogger(this.name);
    this.metrics = options.metrics || shared.observability.createMetrics(this.name);

    this.pool = options.pool || shared.postgres.createPool(this.logger, {
      schema: config.schemas.user,
    });

    this.redis = options.redis || shared.redis.createRedisClient(this.logger);
    this.cache = options.cache || shared.redis.createCacheAside(this.redis, this.logger, {
      prefix: 'spacefractions:user',
      ttlSeconds: 300,
    });

    this.messaging = options.messaging || shared.messaging.createMessaging(this.logger, {
      component: this.name,
    });

    // Consume the question-updated and game-completed events that other
    // components publish. Section G ("user engagement") needs that counter.
    this.engagement = { gamesCompleted: 0, questionsAnswered: 0 };

    this.repository = options.repository || new UserRepository({
      pool: this.pool,
      cache: this.cache,
      logger: this.logger,
      schema: config.schemas.user,
      metrics: this.metrics,
    });

    this.service = options.service || new UserService({
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
        { name: 'postgres', check: () => shared.postgres.ping(this.pool), required: true },
        { name: 'redis', check: () => this.redis.isReady, required: false },
        { name: 'rabbitmq', check: () => this.messaging.isConnected(), required: false },
      ],
      // Registered through the factory's mount hook so these routes land before
      // its terminal 404 handler.
      mountRoutes: (app) => {
        app.use(createUserRoutes({ service: this.service, logger: this.logger }));

        // Section G: "Create a runbook for common issues and errors."
        app.get('/internal/engagement', (req, res) => {
          res.json(this.engagement);
        });
      },
    });
  }

  async initialise() {
    try {
      await this.service.ensureAdmin();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'admin bootstrap skipped (database not ready?)');
    }
    try {
      await this.messaging.subscribe(
        'spacefractions.user.engagement',
        ['game.completed', 'question.answered', 'user.authenticated'],
        (event, routingKey) => {
          if (routingKey === config.rabbitmq.events.gameCompleted) this.engagement.gamesCompleted += 1;
          if (routingKey === config.rabbitmq.events.answerSubmitted) this.engagement.questionsAnswered += 1;
          this.logger.debug({ routingKey, event: event && event.gameId }, 'consumed event');
        },
      );
    } catch (err) {
      this.logger.warn({ err: err.message }, 'event subscription skipped');
    }
    // Section F: "Rotate secrets regularly" - drop expired refresh tokens.
    try {
      const purged = await this.repository.purgeExpiredRefreshTokens();
      this.logger.info({ purged }, 'expired refresh tokens purged');
    } catch (err) {
      this.logger.debug({ err: err.message }, 'refresh token purge skipped');
    }
  }

  async start() {
    const { port, host } = config.user;
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

module.exports = { UserComponent };
