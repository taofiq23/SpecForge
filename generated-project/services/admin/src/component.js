'use strict';

/**
 * AdminComponent - the fourth artifact named in the ComponentDiagram (spec.json
 * view 9):
 *
 *   artifact GameComponent
 *   artifact QuestionComponent
 *   artifact UserComponent
 *   artifact AdminComponent
 *   GameComponent -- QuestionComponent
 *   GameComponent -- UserComponent
 *   GameComponent -- AdminComponent
 *
 * This is a real, findable module - not prose. It was previously only mentioned
 * in architecture.md; it now has the same treatment as the other three
 * components:
 *
 *   services/admin/src/component.js      <- this file (the AdminComponent class)
 *   services/admin/src/routes/…          <- its HTTP surface
 *   services/admin/src/service/…         <- its application layer
 *   services/admin/src/server.js         <- optional standalone entry point
 *
 * Deployment choice: AdminComponent is *hosted inside the GameComponent process*
 * by default, because the ComponentDiagram wires `GameComponent -- AdminComponent`
 * and the traceability matrix does not list a fourth deployable. `component.js`
 * exposes `mountOn(app)` so GameComponent can attach it, and `server.js` lets you
 * boot it standalone (ADMIN_PORT) if you want to scale the admin surface apart
 * from the game, per the DeploymentDiagram's separate AdminClient node.
 *
 * It owns no tables of its own - the ClassDiagram makes `Admin --* Question` a
 * composition over QuestionComponent's data, so admin writes are proxied to
 * QuestionComponent exactly as SequenceDiagram2 draws them.
 */
const shared = require('@spacefractions/shared');
const { config } = shared;

const { AdminService } = require('./service/adminService');
const { createAdminRoutes, ADMIN_BASE_PATH } = require('./routes/adminRoutes');

class AdminComponent {
  constructor(options = {}) {
    this.name = 'AdminComponent';
    this.config = config;
    this.logger = options.logger || shared.createLogger(this.name);
    this.metrics = options.metrics || shared.observability.createMetrics(this.name);
    this.basePath = options.basePath || ADMIN_BASE_PATH;

    // GameComponent -- QuestionComponent client. AdminComponent talks to
    // QuestionComponent through the same REST client the game uses, which is
    // what SequenceDiagram2 (Admin ->> Question : update()) depicts.
    this.questionClient = options.questionClient || createQuestionClient(this.logger, this.metrics);

    // Optional: only needed for the section G stats endpoint.
    this.gameService = options.gameService || null;

    this.adminService = options.adminService || new AdminService({
      questionClient: this.questionClient,
      gameService: this.gameService,
      logger: this.logger,
      metrics: this.metrics,
    });

    this.router = createAdminRoutes({ adminService: this.adminService, logger: this.logger });
  }

  /** ComponentDiagram: GameComponent -- AdminComponent */
  mountOn(app) {
    app.use(this.basePath, this.router);
    this.logger.info({ basePath: this.basePath }, 'AdminComponent mounted');
    return this;
  }

  /** Standalone deployment (optional): build a full app of our own. */
  buildApp() {
    return shared.http.createApp({
      componentName: this.name,
      logger: this.logger,
      metrics: this.metrics,
      readyChecks: [
        {
          name: 'question-component',
          check: () => (this.questionClient && this.questionClient.health
            ? this.questionClient.health()
            : false),
          required: true,
        },
      ],
      mountRoutes: (app) => this.mountOn(app),
    });
  }

  async start() {
    const port = Number.parseInt(process.env.ADMIN_PORT || '8084', 10);
    const host = process.env.ADMIN_HOST || '0.0.0.0';
    this.server = this.buildApp().listen(port, host, () => {
      this.logger.info({ port, host, component: this.name }, `${this.name} listening`);
    });
    return this.server;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

function createQuestionClient(logger, metrics) {
  const { QuestionComponentClient } = require('@spacefractions/game/src/clients/questionClient');
  return new QuestionComponentClient({
    baseUrl: shared.http.createServiceRegistry(config).question,
    logger,
    metrics,
  });
}

module.exports = { AdminComponent, ADMIN_BASE_PATH };
