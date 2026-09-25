'use strict';

/**
 * GameComponent - the component named in the ComponentDiagram (spec.json view 9)
 * and in the traceability matrix (FR-1, NFR-1).
 *
 *   artifact GameComponent
 *   artifact QuestionComponent
 *   artifact UserComponent
 *   artifact AdminComponent
 *   GameComponent -- QuestionComponent
 *   GameComponent -- UserComponent
 *   GameComponent -- AdminComponent
 *
 * Responsibilities (spec section C/D): "game logic and user interaction. It owns
 * the game state data."
 *
 * Recommended stack (spec section D): Node.js 18, Express.js 4, PostgreSQL 14,
 * Redis 6, RabbitMQ 3, Elasticsearch 7, OAuth2, Prometheus 2, Jenkins 2,
 * Docker 20, Terraform 1.
 *
 * This process also hosts, in-process:
 *   - AdminComponent          (ComponentDiagram: GameComponent -- AdminComponent)
 *   - the UserClient/AdminClient static UI
 *                             (DeploymentDiagram: GameServer -- UserClient /
 *                              GameServer -- AdminClient)
 */
const shared = require('@spacefractions/shared');
const { config } = shared;

const { GameService } = require('./service/gameService');
const { GameRepository } = require('./repository/gameRepository');
const { QuestionComponentClient } = require('./clients/questionClient');
const openApiDocument = require('./openapiDocument');
const { createStaticUIRoutes } = require('./routes/uiRoutes');
const { AdminComponent } = require('../../admin/src/component');

class GameComponent {
  constructor(options = {}) {
    this.name = 'GameComponent';
    this.config = options.config || config;
    this.logger = options.logger || shared.createLogger(this.name);
    this.metrics = options.metrics || shared.observability.createMetrics(this.name);

    // PostgreSQL 14 - owns game state (spec section D data model).
    this.pool = options.pool || shared.postgres.createPool(this.logger, {
      schema: config.schemas.game,
    });

    // Redis 6 - "Cache game state in Redis".
    this.redis = options.redis || shared.redis.createRedisClient(this.logger);
    this.cache = options.cache || shared.redis.createCacheAside(this.redis, this.logger, {
      prefix: 'spacefractions:game',
      ttlSeconds: config.redis.gameStateTtlSeconds,
    });

    // RabbitMQ 3 - event publishing.
    this.messaging = options.messaging || shared.messaging.createMessaging(this.logger, {
      component: this.name,
    });

    // Elasticsearch 7 is owned by QuestionComponent, but GameComponent indexes
    // completed sessions for the analytics/engagement use case named in
    // section G ("user engagement"). Optional: degrades to a no-op.
    this.search = options.search || shared.search.createSearchClient(this.logger, 'spacefractions-games');

    this.repository = options.repository || new GameRepository({
      pool: this.pool,
      cache: this.cache,
      logger: this.logger,
      schema: config.schemas.game,
      metrics: this.metrics,
    });

    this.questionClient = options.questionClient || new QuestionComponentClient({
      baseUrl: shared.http.createServiceRegistry(config).question,
      logger: this.logger,
      metrics: this.metrics,
    });

    this.service = options.service || new GameService({
      repository: this.repository,
      questionClient: this.questionClient,
      messaging: this.messaging,
      metrics: this.metrics,
      logger: this.logger,
      config,
    });

    // ComponentDiagram: GameComponent -- AdminComponent.
    // AdminComponent is a real module (services/admin) hosted in this process by
    // default; component.js also supports running it standalone.
    this.adminComponent = options.adminComponent || new AdminComponent({
      logger: this.logger,
      metrics: this.metrics,
      questionClient: this.questionClient,
      gameService: this.service,
    });

    this.app = this.buildApp();
  }

  buildApp() {
    const { createGameRoutes } = require('./routes/gameRoutes');
    return shared.http.createApp({
      componentName: this.name,
      logger: this.logger,
      metrics: this.metrics,
      openApiDocument,
      readyChecks: [
        // PostgreSQL is authoritative -> required for readiness (ASR-1).
        { name: 'postgres', check: () => shared.postgres.ping(this.pool), required: true },
        // Redis and RabbitMQ degrade gracefully -> reported but not required (NFR-1).
        { name: 'redis', check: () => this.redis.isReady, required: false },
        { name: 'rabbitmq', check: () => this.messaging.isConnected(), required: false },
        { name: 'question-component', check: () => this.questionClient.health(), required: false },
      ],
      // Routes are registered through the factory's mount hook so they are added
      // before its terminal 404 handler.
      mountRoutes: (app) => {
        app.use(createGameRoutes({ service: this.service, logger: this.logger }));

        // Admin surface: ComponentDiagram wires GameComponent -- AdminComponent.
        this.adminComponent.mountOn(app);

        // DeploymentDiagram: GameServer -- UserClient / AdminClient.
        // Plain HTML/CSS/JS served as static files (no build step); see
        // services/game/src/routes/uiRoutes.js and web/.
        if (this.config.webUiEnabled !== false) {
          app.use(createStaticUIRoutes({ logger: this.logger }));
        }
      },
    });
  }

  async start() {
    const { port, host } = config.game;
    this.server = this.app.listen(port, host, () => {
      this.logger.info(
        { port, host, component: this.name },
        `${this.name} listening`,
      );
      this.logger.info(
        { url: `http://localhost:${port}/`, admin: `http://localhost:${port}/admin` },
        'Space Fractions UI available',
      );
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

module.exports = { GameComponent };
